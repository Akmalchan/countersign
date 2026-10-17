// Domain registration date from public RDAP (free, no key). Not a Glasser call.
// Returns { status: 'registered'|'not_registered'|'unknown', registeredAt?, ageDays? }.

const cache = new Map();

export async function domainAge(domain) {
  if (cache.has(domain)) return cache.get(domain);
  let out = { status: 'unknown' };
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      redirect: 'follow',
      // rdap.org returns 403 without a descriptive user agent.
      headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'countersign/0.1 (invoice-check hackathon demo)' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 404) out = { status: 'not_registered' };
    else if (res.ok) {
      const d = await res.json();
      const reg = (d.events || []).find((e) => e.eventAction === 'registration')?.eventDate;
      if (reg) {
        const ageDays = Math.floor((Date.now() - Date.parse(reg)) / 86400000);
        out = { status: 'registered', registeredAt: reg.slice(0, 10), ageDays };
      } else out = { status: 'registered' };
    }
  } catch { /* network or TLD without RDAP: stay unknown */ }
  cache.set(domain, out);
  return out;
}
