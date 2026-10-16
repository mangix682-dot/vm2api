export const RUNTIME_DOCKER = 'docker'
export const RUNTIME_KVM = 'kvm'
export const RUNTIME_NATIVE = 'native'

const KVM_ALIASES = new Set(['kvm', 'qemu', 'libvirt'])

/** Slot hypervisor kind. Default docker so existing vm.json keeps working. */
export function runtimeKind(vm = {}) {
  const raw = String(vm?.runtime?.type || vm?.runtime_type || '')
    .trim()
    .toLowerCase()
  if (KVM_ALIASES.has(raw)) return RUNTIME_KVM
  if (raw === RUNTIME_NATIVE) return RUNTIME_NATIVE
  return RUNTIME_DOCKER
}

export function isKvmRuntime(vm) {
  return runtimeKind(vm) === RUNTIME_KVM
}

export function isNativeRuntime(vm) {
  return runtimeKind(vm) === RUNTIME_NATIVE
}
