// Fast lane: routine bills get a pre-written reason so a person approves with one click.
// It never approves anything by itself, and every rule below must hold:
//   known vendor with at least 2 past bills · stamp CLEAR with risk 0 · no flagged check ·
//   amount within the vendor's usual range · if it came by email, Gmail verified the sender.
// Shared by server and browser.

const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function fastLane(c, vendor) {
  const no = (why) => ({ ok: false, why });
  if (!vendor) return no('new vendor');
  const hist = (vendor.history ?? []).map(Number).filter((n) => n > 0);
  if (hist.length < 2) return no('fewer than 2 past bills from this vendor');
  const s = c.check?.score;
  if (!s || s.band !== 'clear' || s.risk > 0) return no('stamp is not a clean CLEAR');
  if ((c.check.results ?? []).some((r) => r.status === 'flag')) return no('a check is flagged');
  if (c.check.email && !c.check.email.checks.every((x) => x.status === 'pass' || x.id === 'spfdkim')) return no('email not fully verified');
  const amt = Number(c.fields.amount) || 0;
  const max = Math.max(...hist);
  if (amt > max * 1.5) return no('amount above this vendor’s usual range');
  const parts = [`Routine bill from ${vendor.name}: known vendor with ${hist.length} past bills, ${usd(amt)} is within the usual range (up to ${usd(max)})`, 'all 8 checks passed'];
  if (c.check.email) parts.push('sender verified by Gmail (DMARC pass)');
  return { ok: true, reason: parts.join(', ') + '.' };
}
