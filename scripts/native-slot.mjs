#!/usr/bin/env node
/** Offline single-slot provisioning. Never prints account credentials. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativePaths } from '../src/lib/vm/native-runtime.mjs'
import { isNativeRuntime } from '../src/lib/vm/runtime-kind.mjs'
import { seedFreshCliHome } from '../src/lib/vm/vm-recreate.mjs'
import { writeWorkerFiles } from '../src/lib/vm/vm-runtime.mjs'
import { atomicWriteJson, listVmRecordFiles } from '../src/lib/vm/vm-file.mjs'
import {
  normalizeOauth,
  persistOauthToVm,
  readWorkerCredentialFile,
  writeWorkerCredentialFile,
} from '../src/lib/oauth/oauth-credentials.mjs'
import { looksLikeOfficialSetupToken, officialSetupTokenToOauth } from '../src/lib/oauth/claude-setup-token.mjs'

const root = path.resolve(process.env.KIN_PROJECT_ROOT || fileURLToPath(new URL('..', import.meta.url)))
const p = nativePaths(root, 'vm-001')
const recordPath = path.join(root, 'vms', 'vm-001.json')
const [command = 'status', input] = process.argv.slice(2)
try {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0)
    throw new Error('Use an unprivileged user on Linux x86_64')
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true, mode: 0o700 })
  const records = listVmRecordFiles(path.join(root, 'vms'))
  if (records.some((name) => name !== 'vm-001.json'))
    throw new Error('native mode supports one slot only; use a separate project directory')
  let vm = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null
  if (vm && !isNativeRuntime(vm)) throw new Error('Refusing to replace an existing non-native slot')
  if (command === 'init') {
    if (!vm) {
      vm = {
        id: 'vm-001',
        name: 'native-wrap',
        status: 'running',
        runtime: {
          type: 'native',
          project_root: root,
          worker: 'rust',
          kernel_socket: p.socket,
          worker_socket: path.join(p.run, 'worker.sock'),
          worker_token_file: p.token,
        },
        inference_engine: 'rust',
        dataplane: 'wrap',
        timezone: process.env.TZ || 'UTC',
        locale: 'en_US.UTF-8',
        proxy: { id: 'px-local', scheme: 'local' },
        proxy_required: false,
        proxy_cli_enabled: true,
        schedulable: false,
        schedule_disabled_reason: 'no_credential',
        claude: {},
        policy: { maxConcurrency: 1, concurrencyOverride: true, maxRpm: 0, weight: 1 },
        seed_policy: { telemetry_disabled: true },
        created_at: new Date().toISOString(),
      }
      atomicWriteJson(recordPath, vm, { mode: 0o600 })
    }
    seedFreshCliHome(root, vm)
    writeWorkerFiles(vm, root, { transparent: false })
    atomicWriteJson(path.join(root, 'vms', 'active.json'), { active_vm: vm.id }, { mode: 0o600 })
  } else if (command === 'import') {
    if (!vm || !input)
      throw new Error(
        'Usage: node scripts/native-slot.mjs init; node scripts/native-slot.mjs import /path/to/credentials.json',
      )
    const raw = fs.readFileSync(path.resolve(input), 'utf8').trim()
    let credential
    try {
      const document = JSON.parse(raw)
      credential = document.claudeAiOauth || document
    } catch {
      credential = raw
    }
    if (typeof credential === 'string') {
      if (!looksLikeOfficialSetupToken(credential)) throw new Error('Expected sk-ant-oat01-... official Setup Token')
      credential = officialSetupTokenToOauth(credential)
    }
    const n = normalizeOauth(credential)
    const official = looksLikeOfficialSetupToken(n.access_token) && !n.refresh_token
    if (!official && (!n.access_token || !n.refresh_token)) {
      throw new Error('Expected subscription OAuth accessToken and refreshToken, or an official sk-ant-oat01-... Setup Token')
    }
    writeWorkerCredentialFile(p.home, credential)
    vm = persistOauthToVm(recordPath, credential, { acceptLiveGrant: true })
    vm.schedulable = true
    vm.schedule_disabled_reason = null
    atomicWriteJson(recordPath, vm, { mode: 0o600 })
    writeWorkerFiles(vm, root, { transparent: false })
  } else if (command !== 'status') throw new Error('Commands: init, import <credential-file>, status')
  const credential = readWorkerCredentialFile(p.home)
  console.log(
    JSON.stringify(
      {
        ok: true,
        id: vm?.id || null,
        runtime: vm?.runtime?.type || null,
        credential_present: !!credential,
        schedulable: vm?.schedulable === true,
        home: p.home,
        socket: p.socket,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
