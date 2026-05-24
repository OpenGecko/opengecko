
import type { RuntimeDiagnostics } from '../runtime-diagnostics';
import { INJECTED_PROVIDER_FAILURE_RUNTIME_FAMILY_IDS } from './constants';

export function runtimeAffectsFamily(runtimeDiagnostics: RuntimeDiagnostics, runtimeFamilyIds: string[]) {
  if (
    runtimeDiagnostics.degraded.injected_provider_failure.active
    && runtimeFamilyIds.some((runtimeFamilyId) => INJECTED_PROVIDER_FAILURE_RUNTIME_FAMILY_IDS.has(runtimeFamilyId))
  ) {
    return true;
  }

  if (runtimeDiagnostics.degraded.active) {
    return true;
  }

  return (runtimeDiagnostics.providers ?? []).some((provider) =>
    provider.alert_status !== 'healthy'
    && provider.capabilities.some((capability) =>
      capability.state === 'degraded'
      && capability.endpoint_families.some((endpointFamily) =>
        runtimeFamilyIds.some((runtimeFamilyId) => endpointFamily.includes(runtimeFamilyId) || (
          runtimeFamilyId === 'coins_markets' && endpointFamily.includes('/coins/markets')
        ) || (
          runtimeFamilyId === 'simple' && endpointFamily.includes('/simple')
        ) || (
          runtimeFamilyId === 'exchanges' && endpointFamily.includes('/exchanges')
        )),
      ),
    ),
  );
}

export function providerReasonCodes(runtimeDiagnostics: RuntimeDiagnostics) {
  const codes = new Set<string>();
  if (runtimeDiagnostics.degraded.active) {
    codes.add('runtime_degraded');
  }
  if (
    runtimeDiagnostics.degraded.validation_override.mode === 'stale_allowed'
    || runtimeDiagnostics.degraded.validation_override.mode === 'stale_disallowed'
  ) {
    codes.add('stale_source');
  }
  if (runtimeDiagnostics.degraded.injected_provider_failure.active) {
    codes.add('provider_error');
  }
  for (const provider of runtimeDiagnostics.providers ?? []) {
    if (provider.alert_status !== 'healthy') {
      if (provider.failure_kind === 'regional_block') {
        codes.add('provider_blocked');
        codes.add('regional_block');
      } else {
        codes.add(provider.state === 'open' ? 'provider_error' : 'provider_degraded');
      }
    }
  }
  return [...codes].sort();
}
