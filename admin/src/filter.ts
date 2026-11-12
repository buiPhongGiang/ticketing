import type { DashboardTicket } from '../../app/src/lib/dashboard';

export type StatusFilter = 'all' | 'entered' | 'waiting';

export function filterTickets(tickets: DashboardTicket[], query: string, status: StatusFilter): DashboardTicket[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  return tickets.filter((t) => {
    if (status === 'entered' && !t.checkedIn) return false;
    if (status === 'waiting' && t.checkedIn) return false;
    if (!q) return true;
    // Four or more characters may be a piece of the address, such as the last four shown as 0x7099…79C8.
    return t.tokenId === q || (q.length >= 4 && t.owner.toLowerCase().includes(q));
  });
}
