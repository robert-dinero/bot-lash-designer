// ─── Domain-agnostic types (retained across phases) ──────────────────────────

export interface User {
  phone: string;
  created_at: string;
}

export interface Session {
  phone: string;
  cart_json: string; // Will be repurposed in Phase 2 for appointment state JSON
  misunderstanding_count: number;
  created_at: string;
  updated_at: string;
  status?: string;
}

export interface Message {
  id?: number;
  phone: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

// ─── Lash studio scheduling types ────────────────────────────────────────────

export type AppointmentStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show' | 'rescheduled';

export interface Chair {
  id: number;
  name: string;
  active: number; // 1 = active, 0 = inactive
}

export interface Service {
  id: number;
  name: string;
  duration_minutes: number;
  price_cents: number;
  active: number;
}

export interface Appointment {
  id: number;
  chair_id: number;
  client_phone: string;
  service_id: number;
  starts_at: string;       // ISO datetime string
  duration_minutes: number;
  reminder_24h_sent_at?: string | null;
  reminder_12h_sent_at?: string | null;
  reminder_2h_sent_at?: string | null;
  cancelled_at?: string | null;
  escalation_status?: string | null;
  status: AppointmentStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkingHours {
  id: number;
  chair_id: number;
  day_of_week: number;       // 0=Sunday, 1=Monday, ..., 6=Saturday
  open_time: string;         // 'HH:MM'
  close_time: string;        // 'HH:MM'
  is_closed: number;         // 1 = closed that day
  break_start: string | null; // 'HH:MM' or null
  break_end: string | null;   // 'HH:MM' or null
}

export interface AvailabilityBlock {
  id: number;
  chair_id: number;
  starts_at: string; // ISO datetime
  ends_at: string;   // ISO datetime
  reason: string | null;
}

// ─── Appointment state machine (session.cart_json serialization) ──────────────

export interface AppointmentState {
  businessName?: string;               // guards against reused sessions from another bot/business
  service?: string;                    // legado — mantido para fallback gracioso durante deploy
  serviceId?: number;                  // preferido: ID numérico da tabela services (D-03)
  clientName?: string;                 // Client name collected before confirmation
  nameAsked?: boolean;                 // true after the system sent the greeting and is waiting for the name
  requestedDateTime?: string;          // User's initial request (may be vague like "amanhã")
  resolvedDay?: string;                // ISO date string of the resolved target day (persisted across turns)
  confirmedDateTime?: string;          // ISO datetime confirmed by bot (must validate against slots)
  confirmedTime?: string;              // HH:MM chosen by user — backend combines with slotDay to build confirmedDateTime
  confirmed: boolean;                  // true only after validation + user says "sim"
  reschedulingAppointmentId?: number;  // setado durante o fluxo de remarcação (D-14)
}

export interface BusinessConfig {
  businessName: string;
  services?: Array<{ name: string; duration: number; price: number }>;
  paymentMethods?: string[];
  tone?: string;
}

// ─── Reminder scheduling types ──────────────────────────────────────────────

export type ReminderType = '24h' | '12h' | '2h' | 'morning';

export interface DueReminder {
  appointmentId: number;
  clientPhone: string;
  appointmentTime: string; // ISO datetime string
  reminderType: ReminderType;
  shouldSendNow: boolean;  // true if within business hours (8am-9pm PT-BR)
  nextSendAt?: string;     // ISO datetime to retry if outside window
}

export interface ReminderDecision {
  appointmentId: number;
  reminderType: ReminderType;
  message: string;         // Formatted message to send
  shouldSend: boolean;     // Whether to send now or defer
  nextRetryAt?: string;    // When to retry if outside window
}

// ─── Cancellation types ──────────────────────────────────────────────────────

export type EscalationStatus = 'pending' | 'approved' | 'denied' | null;

export interface CancellationDecision {
  allowed: boolean;                    // true = cancel immediately, false = escalate
  hoursUntilAppointment: number;       // Time delta in hours (can be negative if past)
  deadlineHour?: number;               // Hour when cancellation deadline passed (e.g., 09 for "até as 09h")
  clientMessage: string;               // What to tell the client
  shouldNotifyOwner: boolean;          // If true, send escalation to owner
  escalationReason?: string;           // Why escalated (e.g., "within 6-hour window")
}
