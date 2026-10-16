import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  nativePaths,
  nativeEnvironment,
  startNativeSlot,
  stopNativeSlot,
  nativeProcessStatus,
} from '../../src/lib/vm/native-runtime.mjs'
import { writeWorkerFiles } from '../../src/lib/vm/vm-runtime.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'
import { callRustKernel } from '../../src/lib/transport/rust-kernel-client.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'
import { readGuestIdentity } from '../../src/lib/vm/guest-identity-reader.mjs'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'

const project = path.resolve(import.meta.dirname, '../..')
const enabled =
  process.platform === 'linux' &&
  process.arch === 'x64' &&
  process.getuid() !== 0 &&
  fs.existsSync(path.join(project, 'share/wrap-cli/cli-node')) &&
  fs.existsSync(path.join(project, 'bin/kin-worker'))

test('native wrap: lifecycle, client tools, cancellation and worker refresh', {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-'))
  const vm = {
    id: 'vm-001',
    runtime: { type: 'native', project_root: root },
    dataplane: 'wrap',
    proxy: { id: 'px-local', scheme: 'local' },
    proxy_required: false,
    seed_policy: { telemetry_disabled: true },
  }
  t.after(async () => {
    await stopNativeSlot(vm)
    fs.rmSync(root, { force: true, recursive: true })
  })
  fs.mkdirSync(path.join(root, 'share'), { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'))
  fs.symlinkSync(path.join(project, 'share/wrap-cli'), path.join(root, 'share/wrap-cli'))
  fs.symlinkSync(path.join(project, 'bin/kin-worker'), path.join(root, 'bin/kin-worker'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms/vm-001.json'), JSON.stringify(vm))
  const p = nativePaths(root, vm.id)
  const sentinel = path.join(root, 'tool-must-not-run')
  const requests = []
  let refreshes = 0
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url === '/oauth/token') {
      refreshes++
      assert.equal(JSON.parse(raw).refresh_token, 'fixture-refresh')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          access_token: 'fixture-rotated',
          refresh_token: 'fixture-refresh-next',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'user:inference user:profile',
        }),
      )
    }
    if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end()
    const body = JSON.parse(raw)
    requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    emit({
      type: 'message_start',
      message: {
        id: 'msg_native',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    })
    if (JSON.stringify(body.messages).includes('HANG_REQUEST')) return
    const hasResult = JSON.stringify(body.messages).includes('WINDOWS_FILE_CONTENT')
    const wantsTool = body.tools?.length && !hasResult
    if (wantsTool) {
      emit({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_native', name: 'Bash', input: {} },
      })
      emit({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `touch ${sentinel}` }) },
      })
    } else {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      emit({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: hasResult ? 'received WINDOWS_FILE_CONTENT' : 'pong' },
      })
    }
    emit({ type: 'content_block_stop', index: 0 })
    emit({
      type: 'message_delta',
      delta: { stop_reason: wantsTool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })
    emit({ type: 'message_stop' })
    res.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    upstream.closeAllConnections()
    upstream.close()
  })
  const env = {
    KIN_KERNEL_TEST_ENDPOINTS: '1',
    KIN_WORKER_TEST_ENDPOINTS: '1',
    KIN_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    KIN_OAUTH_TOKEN_URL: `http://127.0.0.1:${upstream.address().port}/oauth/token`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  writeWorkerCredentialFile(p.home, {
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scopes: ['user:inference', 'user:profile'],
  })
  writeWorkerFiles(vm, root, { transparent: false })
  const config = JSON.parse(fs.readFileSync(p.config, 'utf8'))
  assert.equal(config.socket_path, p.socket)
  assert.equal(config.credential_path, p.credential)
  assert.equal(config.claude_bin, p.cli)
  assert.equal(nativeEnvironment(p.home).ANTHROPIC_AUTH_TOKEN, undefined)

  const boot = await Promise.all([startNativeSlot(vm, root), startNativeSlot(vm, root)])
  assert.ok(
    boot.every((result) => result.ok),
    JSON.stringify(boot),
  )
  const firstPid = nativeProcessStatus(vm).pid
  assert.ok(firstPid)
  assert.equal((await startNativeSlot(vm, root)).action, 'already-running')
  assert.equal(nativeProcessStatus(vm).pid, firstPid)
  assert.equal((await startNativeSlot({ ...vm, id: 'vm-002' }, root)).reason, 'native_single_account')

  const exec = slotExec(root, vm)
  const identity = await readGuestIdentity(exec)
  assert.equal(identity.ok, true)
  assert.equal(identity.body.identity.runtime_kind, 'native')
  assert.equal(identity.body.identity.goos, 'linux')
  const messages = [{ role: 'user', content: 'Read my Windows file using the supplied tool' }]
  const tools = [
    {
      name: 'Bash',
      description: 'Run a command on the client',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ]
  const send = (body, signal) =>
    callRustKernel({
      exec,
      body: { model: 'claude-sonnet-4-5', max_tokens: 128, ...body },
      cliHop: true,
      timeoutMs: 10000,
      signal,
    })
  const first = await send({ messages, tools })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.body.stop_reason, 'tool_use')
  const tool = first.body.content.find((block) => block.type === 'tool_use')
  assert.equal(tool.name, 'Bash')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(fs.existsSync(sentinel), false, 'slot executed the client tool')
  assert.equal(requests.length, 1, 'slot continued an agent tool loop on its own')
  const second = await send({
    tools,
    messages: [
      ...messages,
      { role: 'assistant', content: first.body.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'WINDOWS_FILE_CONTENT' }] },
    ],
  })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.match(JSON.stringify(second.body), /received WINDOWS_FILE_CONTENT/)
  assert.ok(JSON.stringify(requests[1].messages).includes('WINDOWS_FILE_CONTENT'))

  const controller = new AbortController()
  const hanging = send({ messages: [{ role: 'user', content: 'HANG_REQUEST' }] }, controller.signal)
  const deadline = Date.now() + 5000
  while (requests.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(requests.length, 3)
  controller.abort()
  await hanging
  assert.equal((await send({ messages: [{ role: 'user', content: 'after cancel' }] })).ok, true)

  const refreshed = await runSlotOauth(exec, 'refresh', { force: true })
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed))
  assert.equal(refreshes, 1)
  assert.equal(readWorkerCredentialFile(p.home).access_token, 'fixture-rotated')
  assert.equal(readWorkerCredentialFile(p.home).refresh_token, 'fixture-refresh-next')
  await stopNativeSlot(vm)
  assert.equal(nativeProcessStatus(vm).running, false)
  const restarted = await startNativeSlot(vm, root)
  assert.equal(restarted.ok, true)
  assert.ok(Number.isInteger(restarted.health.cli_pid) && restarted.health.cli_pid > 0)
  assert.notEqual(nativeProcessStatus(vm).pid, firstPid)
  process.kill(nativeProcessStatus(vm).pid, 'SIGKILL')
  const crashDeadline = Date.now() + 3000
  while (nativeProcessStatus(vm).running && Date.now() < crashDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.equal(nativeProcessStatus(vm).running, false)
  const cliStat = `/proc/${restarted.health.cli_pid}/stat`
  const cliDeadline = Date.now() + 3000
  const cliAlive = () => {
    try {
      return !fs.readFileSync(cliStat, 'utf8').split(') ')[1].startsWith('Z')
    } catch {
      return false
    }
  }
  while (cliAlive() && Date.now() < cliDeadline) await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(cliAlive(), false, 'kernel crash left its CLI running')
  await stopNativeSlot(vm)
  const cancelled = startNativeSlot(vm, root)
  await stopNativeSlot(vm)
  assert.equal((await cancelled).reason, 'start_cancelled')
  assert.equal(nativeProcessStatus(vm).running, false)
})
