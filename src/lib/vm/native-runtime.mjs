/** Single-account Linux process backend. All children share the service user's uid. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { resolveKernelDataplane } from './slot-engine.mjs'

const runFile = promisify(execFile)
const children = new Map()
const starts = new Map()
const generations = new Map()

export function nativePaths(projectRoot, id) {
  if (!projectRoot || !/^vm-[0-9]+$/.test(String(id || ''))) throw new Error('native slot requires a numeric vm id')
  const root = path.resolve(projectRoot)
  const slot = path.join(root, 'vms', id)
  const home = path.join(slot, 'cli-home')
  const run = path.join(slot, 'run')
  return {
    root,
    slot,
    home,
    run,
    kernel: path.join(home, '.kin', 'kin-kernel'),
    cli: path.join(home, '.kin', 'cli-node'),
    worker: path.join(root, 'bin', 'kin-worker'),
    config: path.join(run, 'kernel.json'),
    workerConfig: path.join(run, 'worker.json'),
    socket: path.join(run, 'kernel.sock'),
    token: path.join(run, 'internal.token'),
    credential: path.join(home, '.claude', 'credentials.json'),
    log: path.join(run, 'kernel.log'),
  }
}

export function nativeProjectRoot(vm, homeDir) {
  return vm?.runtime?.project_root || process.env.KIN_PROJECT_ROOT || (homeDir ? path.resolve(homeDir, '../../..') : '')
}

export function nativeEnvironment(homeDir, vm = {}) {
  const env = {
    ...process.env,
    HOME: homeDir,
    TZ: vm.timezone || process.env.TZ || 'UTC',
    LANG: vm.locale || 'en_US.UTF-8',
  }
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
  ])
    delete env[name]
  for (const name of Object.keys(env)) {
    if (name.startsWith('VM2API_') || /^(KIN_API_KEY|KIN_ADMIN_PASSWORD|KIN_DB_SECRET)$/.test(name)) delete env[name]
  }
  // A deliberately enabled fixture endpoint is the only base URL override.
  if (process.env.KIN_KERNEL_TEST_ENDPOINTS === '1' && process.env.KIN_ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = process.env.KIN_ANTHROPIC_BASE_URL
  }
  return env
}

export function nativeProcessStatus(vm) {
  const child = children.get(vm?.id)
  const running = !!child?.pid && child.exitCode === null && child.signalCode === null
  return {
    exists: !!child,
    running,
    status: running ? 'running' : 'stopped',
    pid: running ? child.pid : null,
    log_tail: [],
  }
}

export async function stopNativeSlot(vm, { cancelStart = true } = {}) {
  if (cancelStart) generations.set(vm?.id, (generations.get(vm?.id) || 0) + 1)
  const child = children.get(vm?.id)
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    if (children.get(vm?.id) === child) children.delete(vm?.id)
    return { ok: true, action: 'already-stopped' }
  }
  const exited = new Promise((resolve) => child.once('close', resolve))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 5000)
  timer.unref()
  await exited
  clearTimeout(timer)
  if (children.get(vm.id) === child) children.delete(vm.id)
  return { ok: true, action: 'stopped' }
}

export async function stopAllNativeSlots() {
  await Promise.all([...new Set([...children.keys(), ...starts.keys()])].map((id) => stopNativeSlot({ id })))
  await Promise.allSettled([...starts.values()])
}

export async function startNativeSlot(vm, projectRoot, { routing, force = false, timeoutMs = 30000 } = {}) {
  if (starts.has(vm.id)) return starts.get(vm.id)
  const pending = start(vm, projectRoot, { routing, force, timeoutMs })
  starts.set(vm.id, pending)
  try {
    return await pending
  } finally {
    if (starts.get(vm.id) === pending) starts.delete(vm.id)
  }
}

async function start(vm, projectRoot, { routing, force, timeoutMs }) {
  const generation = generations.get(vm.id) || 0
  if (process.platform !== 'linux' || process.arch !== 'x64')
    return { ok: false, reason: 'native_platform', error: 'native wrap requires Linux x86_64' }
  if (process.getuid() === 0)
    return { ok: false, reason: 'native_root_forbidden', error: 'run native wrap as an unprivileged service user' }
  if (vm.node_id || (vm.proxy && vm.proxy.id !== 'px-local' && vm.proxy.scheme !== 'local'))
    return {
      ok: false,
      reason: 'native_local_exit_required',
      error: 'native wrap currently supports the VM default route only',
    }
  if (resolveKernelDataplane(vm, routing || {}) !== 'wrap')
    return { ok: false, reason: 'native_wrap_required', error: 'native backend only supports wrap' }
  if ([...starts.keys()].some((id) => id !== vm.id))
    return { ok: false, reason: 'native_single_account', error: 'only one native slot may run per service' }
  for (const [id, child] of children) {
    if (id !== vm.id && child.exitCode === null && child.signalCode === null)
      return { ok: false, reason: 'native_single_account', error: 'only one native slot may run per service' }
  }
  const p = nativePaths(projectRoot, vm.id)
  const { writeWorkerFiles } = await import('./vm-runtime.mjs')
  const { materializeWrapCli } = await import('./wrap-cli-runtime.mjs')
  const { rustKernelHealth, rustKernelReachable } = await import('../transport/rust-kernel-client.mjs')
  if ((generations.get(vm.id) || 0) !== generation) return { ok: false, reason: 'start_cancelled' }
  const wrap = materializeWrapCli(p.root, vm)
  if (!wrap.ok) return { ok: false, reason: wrap.code || 'wrap_cli_missing', error: wrap.error }
  vm.runtime = {
    ...vm.runtime,
    type: 'native',
    project_root: p.root,
    worker: 'rust',
    worker_socket: path.join(p.run, 'worker.sock'),
    worker_run_dir: p.run,
    worker_token_file: p.token,
    kernel_socket: p.socket,
  }
  writeWorkerFiles(vm, p.root, { transparent: false, routing })
  const exec = { vmId: vm.id, vm, homeDir: p.home }
  if (force) await stopNativeSlot(vm, { cancelStart: false })
  if (nativeProcessStatus(vm).running) {
    const health = await rustKernelHealth(exec, { timeoutMs: 800 })
    if (rustKernelReachable(health)) return { ok: true, action: 'already-running', runtime: vm.runtime, health }
    await stopNativeSlot(vm, { cancelStart: false })
  }
  if ((generations.get(vm.id) || 0) !== generation) return { ok: false, reason: 'start_cancelled' }
  fs.rmSync(p.socket, { force: true })
  const fd = fs.openSync(p.log, 'a', 0o600)
  const child = spawn(p.kernel, ['--gateway-worker', '--config', p.config], {
    cwd: p.home,
    env: nativeEnvironment(p.home, vm),
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  fs.closeSync(fd)
  let failure = null
  child.on('error', (error) => {
    failure = error.message
    if (children.get(vm.id) === child) children.delete(vm.id)
  })
  child.once('exit', () => {
    // The CLI belongs to this process group even when its kernel crashes.
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    if (children.get(vm.id) === child) children.delete(vm.id)
  })
  children.set(vm.id, child)
  const deadline = Date.now() + timeoutMs
  let health
  while (Date.now() < deadline) {
    if ((generations.get(vm.id) || 0) !== generation) {
      await stopNativeSlot(vm, { cancelStart: false })
      return { ok: false, reason: 'start_cancelled' }
    }
    if (failure || child.exitCode !== null || child.signalCode !== null)
      return { ok: false, reason: 'native_kernel_exited', error: failure || `kernel exited; see ${p.log}` }
    health = await rustKernelHealth(exec, { timeoutMs: 500 })
    if (rustKernelReachable(health)) return { ok: true, action: 'started', runtime: vm.runtime, health }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await stopNativeSlot(vm, { cancelStart: false })
  return { ok: false, reason: 'health_timeout', error: `native kernel not ready; see ${p.log}`, health }
}

export async function runNativeOauth(exec, op, { stdin = '', timeoutMs = 45000, force = false } = {}) {
  const vm = exec.vm || { id: exec.vmId }
  const p = nativePaths(nativeProjectRoot(vm, exec.homeDir), exec.vmId || vm.id)
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(p.worker, ['oauth', op, '--config', p.workerConfig, ...(force ? ['--force'] : [])], {
        cwd: p.home,
        env: nativeEnvironment(p.home, vm),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      let settled = false
      const finish = (value) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ code: null, stdout: '', stderr: 'native worker timeout', timed_out: true })
      }, timeoutMs)
      child.stdout.on('data', (data) => {
        stdout += data
        if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL')
      })
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-4096)
      })
      child.on('error', (error) => finish({ code: null, stdout: '', stderr: error.message }))
      child.on('close', (code) => finish({ code, stdout, stderr }))
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    })
    return result
  } catch (error) {
    return { code: null, stdout: '', stderr: error.message }
  }
}

export async function readNativeIdentity(exec) {
  return runFile('/bin/sh', ['-c', (await import('./guest-identity-reader.mjs')).READ_IDENTITY], {
    encoding: 'utf8',
    timeout: 5000,
    env: nativeEnvironment(exec.homeDir, exec.vm),
    maxBuffer: 64 * 1024,
  })
}
