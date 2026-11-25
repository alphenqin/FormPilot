import { API_ORIGIN, parseHealth } from '@formpilot/contracts';
export async function requestHealth(origin = API_ORIGIN) {
  const response = await fetch(origin + '/health', {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('API unavailable');
  return parseHealth(await response.json());
}
