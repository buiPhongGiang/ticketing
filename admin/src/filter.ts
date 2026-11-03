import type { DashboardTicket } from '../../app/src/lib/dashboard';

export type StatusFilter = 'all' | 'entered' | 'waiting';

export function filterTickets(tickets: DashboardTicket[], query: string, status: StatusFilter): DashboardTicket[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  return tickets.filter((t) => {
    if (status === 'entered' && !t.checkedIn) return false;
    if (status === 'waiting' && t.checkedIn) return false;
    if (!q) return true;
    return t.tokenId === q || (q.startsWith('0x') && t.owner.toLowerCase().includes(q));
  });
}
