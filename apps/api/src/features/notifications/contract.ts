export type NotificationKind = 'invitation' | 'reminder' | 'closure' | 'test';
export type NotificationState =
  | 'pending'
  | 'leased'
  | 'retry_scheduled'
  | 'provider_accepted'
  | 'skipped'
  | 'failed'
  | 'uncertain';
export type NotificationChannel = 'slack' | 'email';
export type NotificationPolicy = Readonly<{
  revision: number;
  enabled: boolean;
  invitations: boolean;
  closures: boolean;
  reminders: boolean;
  firstReminderHours: number;
  repeatHours: number;
  maximumReminders: number;
}>;
export type NotificationAvailability = Readonly<{
  workspaceId: string;
  emailConfigured: boolean;
  slackConfigured: boolean;
  linkingConfigured: boolean;
}>;
export type OwnSlackLink = Readonly<{ linked: boolean; revision: number; linkedAt: string | null }>;
export type OwnNotification = Readonly<{
  id: string;
  pulseId: string | null;
  kind: NotificationKind;
  state: NotificationState;
  channel: NotificationChannel | null;
  createdAt: string;
  updatedAt: string;
}>;
export type OwnNotificationPage = Readonly<{
  workspaceId: string;
  items: readonly OwnNotification[];
  nextCursor: string | null;
}>;
export type DeliverySummary = Readonly<{
  workspaceId: string;
  pulseId: string;
  counts: Readonly<Record<NotificationState, number>>;
  remindersEnabled: boolean;
  revision: number;
}>;
export type DispatchResult =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{
      outcome: 'not_accepted';
      retryable: boolean;
      reason: 'recipient_unavailable' | 'provider_unavailable' | 'configuration_invalid';
      retryAfterMs?: number;
    }>
  | Readonly<{ outcome: 'uncertain'; reason: 'acceptance_unknown' }>;
export type NoticeMessage = Readonly<{
  subject: string;
  text: string;
  html: string;
  slackText: string;
}>;
export type NotificationBatch = Readonly<{ requestId: string; queued: boolean }>;
