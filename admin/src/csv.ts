import type { DashboardTicket } from '../../app/src/lib/dashboard';
import type { IndexedEvent } from './events';

const cell = (value: string) => {
  // A leading formula character would run when the file is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function ticketsCsv(tickets: DashboardTicket[], events: IndexedEvent[]): string {
  const entries = new Map(events.filter((e) => e.name === 'CheckedIn').map((e) => [e.tokenId!, e]));
  const rows = tickets.map((t) => {
    const entry = entries.get(t.tokenId);
    return [t.tokenId, t.owner, t.checkedIn ? 'Đã vào' : 'Chưa vào', entry ? new Date(entry.timestamp * 1000).toISOString() : '', entry?.scanner ?? ''];
  });
  return [['Vé', 'Ví đang giữ', 'Trạng thái', 'Giờ vào cửa', 'Ví soát vé'], ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
