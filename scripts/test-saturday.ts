import { initSchema } from '../src/db/index';
import { validateAppointmentTime, getAvailableSlots } from '../src/services/appointment.service';

async function main() {
  await initSchema();

  // Sábado 16/05/2026 às 18:00 BRT
  const dt = new Date('2026-05-16T18:00:00-03:00');
  console.log(`Testing: ${dt.toISOString()} | Local: ${dt.toLocaleString('pt-BR')} | Day: ${dt.getDay()} (6=Sab) | Hour: ${dt.getHours()}`);

  const valid = await validateAppointmentTime(1, dt, 30);
  console.log(`validateAppointmentTime: ${valid ? '✅ disponível' : '❌ rejeitado'}`);

  const slots = await getAvailableSlots(1, dt, 30);
  console.log(`getAvailableSlots para sábado: ${slots.map(s => s.getHours() + ':' + String(s.getMinutes()).padStart(2,'0')).join(', ')}`);

  process.exit(0);
}

main().catch(console.error);
