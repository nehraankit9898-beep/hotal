/** Shared frontend types — mirror the API responses. */

export type AppRole =
  | "HOTEL_ADMIN"
  | "HOTEL_STAFF"
  | "SUPER_ADMIN"
  | "HOTEL_OWNER"
  | "HOTEL_MANAGER"
  | "MARKETING_MANAGER"
  | "RESTAURANT_MANAGER"
  | "FRONT_DESK"
  // Phase 13 — restaurant staff roles
  | "CASHIER"
  | "KITCHEN_STAFF"
  | "WAITER";

export const ROLE_LABELS: Record<AppRole, string> = {
  HOTEL_ADMIN: "Hotel Admin",
  HOTEL_STAFF: "Staff",
  SUPER_ADMIN: "Platform Super Admin",
  HOTEL_OWNER: "Hotel Owner",
  HOTEL_MANAGER: "Hotel Manager",
  MARKETING_MANAGER: "Marketing Manager",
  RESTAURANT_MANAGER: "Restaurant Manager",
  FRONT_DESK: "Front Desk",
  CASHIER: "Cashier",
  KITCHEN_STAFF: "Kitchen Staff",
  WAITER: "Waiter",
};

export interface SessionUser {
  userId: string;
  hotelId: string;
  role: AppRole;
  name: string;
  email: string;
  hotelName: string;
  mustChangePassword?: boolean;
  mfaSetupRequired?: boolean;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  marketingConsent: boolean;
  optOut: boolean;
  consentTimestamp: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  totalVisits: number;
  lastVisit: string | null;
  campaignEligible: boolean;
  // Phase 2
  vip?: boolean;
  totalSpend?: number;
  // Phase 6.4 — channel-level consent
  whatsappOptIn?: boolean;
  smsOptIn?: boolean;
  emailOptIn?: boolean;
}

export interface CustomersResponse {
  customers: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CustomerProfile {
  customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    marketingConsent: boolean;
    consentTimestamp: string | null;
    consentSource: string | null;
    optOut: boolean;
    status: "ACTIVE" | "INACTIVE";
    createdAt: string;
    updatedAt: string;
    campaignEligible: boolean;
    // Phase 2
    roomPreference: string | null;
    foodPreference: string | null;
    location: string | null;
    birthday: string | null;
    anniversary: string | null;
    source: string | null;
    notes: string | null;
    vip: boolean;
    totalSpend: number;
  };
  stats: {
    totalVisits: number;
    firstVisit: string | null;
    lastVisit: string | null;
    totalSpend: number;
  };
  visits: VisitRow[];
  segments: SegmentBadge[];
  timeline: TimelineEvent[];
}

export interface SegmentBadge {
  id: string;
  name: string;
  type: "AUTO" | "MANUAL";
  color: string | null;
}

export interface TimelineEvent {
  type: string;
  label: string;
  timestamp: string;
  detail?: string;
  amount?: number;
}

export interface VisitRow {
  id: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  checkin: string;
  checkout: string | null;
  source: string;
  notes: string | null;
  amount?: number | null;
  createdAt?: string;
}

export interface VisitsResponse {
  visits: VisitRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface DashboardData {
  stats: {
    totalCustomers: number;
    marketingOptIn: number;
    optedOut: number;
    noConsent: number;
    totalVisits: number;
    uniqueVisitors: number;
    repeatCustomers: number;
    repeatRate: number;
  };
  visitsTrend: { date: string; count: number }[];
  recentCustomers: {
    id: string;
    name: string;
    phone: string;
    createdAt: string;
    marketingConsent: boolean;
  }[];
  recentVisits: {
    id: string;
    createdAt: string;
    checkin: string;
    customer: { id: string; name: string };
  }[];
}

export interface ImportRowCustomer {
  row: number;
  name: string;
  phone: string;
  email: string;
  consent: boolean;
  status: "valid" | "duplicate" | "invalid";
  reason?: string;
}

export interface ImportRowVisit {
  row: number;
  customerPhone: string;
  customerName?: string;
  checkin: string;
  checkout: string;
  status: "valid" | "invalid";
  reason?: string;
}

export interface ImportSummary {
  total: number;
  imported: number;
  duplicates?: number;
  invalid: number;
}

export interface AuditLogRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: string | null;
  user: { name: string; email: string } | null;
  createdAt: string;
}

export interface AuditLogsResponse {
  logs: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type ViewId =
  | "dashboard"
  | "customers"
  | "segments"
  | "visits"
  | "import"
  | "leaderboard"
  | "campaigns"
  | "analytics"
  | "audit"
  | "settings"
  // Phase 3
  | "coupons"
  | "automations"
  | "journeys"
  | "scoring"
  // Phase 4
  | "leads"
  | "integrations"
  // Phase 5
  | "restaurant"
  | "restaurant_leaderboard"
  // Phase 6
  | "super_admin"
  | "system_health"
  | "support"
  | "notifications"
  // Phase 6.3 — restaurant growth
  | "loyalty"
  | "qr_codes"
  | "feedback"
  | "templates"
  // Phase 10 — Super Admin SaaS console views (platform only)
  | "sa_plans"
  | "sa_subscriptions"
  | "sa_coupons"
  | "sa_flags"
  | "sa_billing"
  | "sa_usage"
  | "sa_security"
  | "sa_backups"
  | "sa_templates"
  | "sa_settings"
  // Phase 11 — Developer API
  | "api"
  // Phase 10 — tenant billing & plan view
  | "billing"
  // Phase 12/13 — restaurant operations
  | "menu"
  | "tables"
  | "orders"
  | "kds"
  | "staff"
  // Phase 14 — POS & billing
  | "pos"
  | "bills"
  | "tax_rules"
  // Phase 15 — retention & marketing
  | "promotions"
  | "referrals"
  | "reports"
  // Phase 16 — operations
  | "reservations"
  | "inventory"
  | "attendance"
  | "branches"
  // Phase 18 — advanced AI & innovation
  | "ai";

// ---------------- Phase 10 SaaS types ----------------

export interface PublicPlan {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  yearlyPrice: number;
  currency: string;
  setupFee: number;
  trialDays: number;
  graceDays: number;
  recommended: boolean;
  sortOrder: number;
  features: string[];
  limits: {
    customers: number;
    campaigns: number;
    messages: number;
    staff: number;
    aiRequests: number;
    storageMb: number;
    apiRequests: number;
    exports: number;
    locations: number;
    restaurants: number;
    whatsappMessages: number;
    smsMessages: number;
    apiAccess: boolean;
    advancedAnalytics: boolean;
  };
  isActive?: boolean;
  isArchived?: boolean;
  isPublic?: boolean;
  createdAt?: string;
  usage?: { hotels: number; subscriptions: number };
}

export interface SubscriptionView {
  subscriptionId: string | null;
  state: string;
  access: string;
  plan: {
    id: string;
    key: string;
    name: string;
    monthlyPrice: number;
    yearlyPrice: number;
    currency: string;
  } | null;
  billingCycle: "MONTHLY" | "YEARLY" | null;
  amount: number;
  currency: string;
  startedAt: string | null;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  graceEndsAt: string | null;
  currentPeriodEnd: string | null;
  nextInvoiceAt: string | null;
  provider: string | null;
  blockOnExpiry: boolean;
}

export interface UsageSummaryRow {
  resource: string;
  used: number;
  limit: number;
  allowed: boolean;
  remaining: number | null;
  percent: number;
}

export interface HotelUsageSummaryResponse {
  hotelId: string;
  period: string;
  plan: { id: string; key: string; name: string } | null;
  resources: UsageSummaryRow[];
}

export interface PaymentRow {
  id: string;
  invoiceNumber: string;
  description: string | null;
  amount: number;
  discountAmount: number;
  currency: string;
  status: string;
  provider: string;
  couponCode: string | null;
  billingCycle: string;
  paidAt: string | null;
  refundedAmount?: number;
  createdAt: string;
  hotelId?: string;
  hotelName?: string;
}

export interface SubscriptionRow {
  id: string;
  hotelId: string;
  hotelName: string;
  tenantId: string;
  hotelStatus: string;
  plan: {
    id: string;
    key: string;
    name: string;
    monthlyPrice: number;
    yearlyPrice: number;
    currency: string;
  } | null;
  status: string;
  billingCycle: string;
  amount: number;
  currency: string;
  startedAt: string;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextInvoiceAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  provider: string | null;
}

export interface BillingCouponRow {
  id: string;
  code: string;
  description: string | null;
  discountType: string;
  percentOff: number | null;
  amountOff: number | null;
  maxDiscountAmount: number | null;
  minAmount: number | null;
  usageLimit: number | null;
  perTenantLimit: number | null;
  usedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  applicablePlans: string[] | null;
  isActive: boolean;
  createdAt: string;
}

export interface GlobalFlagRow {
  id: string;
  key: string;
  description: string | null;
  enabled: boolean;
  force: boolean;
  activateAt: string | null;
  deactivateAt: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface SecurityEventRow {
  id: string;
  type: string;
  severity: string;
  email: string | null;
  hotelId: string | null;
  ipAddress: string | null;
  details: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface BackupHistoryRow {
  id: string;
  status: string;
  filename: string | null;
  sizeBytes: number;
  verified: boolean;
  error: string | null;
  durationMs: number;
  reason: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface NotificationTemplateRow {
  id: string;
  key: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  isActive: boolean;
  supportedVariables: string[];
  updatedAt: string;
}

// ---------------- Phase 2 types ----------------

export interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  type: "AUTO" | "MANUAL";
  isSystem: boolean;
  color: string | null;
  rule: {
    kind: string;
    params?: { days?: number; minSpend?: number; weekendRatio?: number };
  } | null;
  memberCount: number;
  createdAt: string;
}

export interface SegmentsResponse {
  segments: SegmentRow[];
}

export interface SegmentMemberRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totalVisits: number;
  totalSpend: number;
  lastVisitAt: string | null;
  vip: boolean;
  campaignEligible: boolean;
  membershipSource: "AUTO" | "MANUAL";
}

export interface SegmentDetailResponse {
  segment: SegmentRow;
  members: SegmentMemberRow[];
}

export interface FollowUpStepRow {
  id: string;
  offsetDays: number;
  label: string;
  messageTemplate: string;
  channels: string[];
  enabled: boolean;
  eligibleToday?: number;
}

export interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  scheduleType: "NOW" | "SCHEDULED" | "AUTOMATED";
  scheduledAt: string | null;
  channels: string[];
  offer: string | null;
  audienceSegment: { id: string; name: string; type: string } | null;
  automated: boolean;
  lastSentAt: string | null;
  createdAt: string;
  audienceSize: number;
  stats: {
    sent: number;
    skipped: number;
    failed: number;
    clicked: number;
    bookings: number;
    revenue: number;
  };
}

export interface CampaignsResponse {
  campaigns: CampaignRow[];
  providerMode: { mode: "SIMULATION" | "LIVE"; whatsapp: boolean; sms: boolean; email: boolean };
  templateVariables: { key: string; description: string }[];
  followUpSteps: {
    id: string;
    offsetDays: number;
    label: string;
    enabled: boolean;
    hasCampaign: boolean;
  }[];
}

export interface CampaignMessageRow {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  channel: string;
  recipient: string;
  status: "PENDING" | "SENT" | "SIMULATED" | "FAILED" | "SKIPPED";
  skipReason: string | null;
  provider: string | null;
  providerMessageId?: string | null;
  failureReason: string | null;
  personalizedMessage: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bookingLinked: boolean;
  bookingAmount: number | null;
  createdAt: string;
}

export interface CampaignDetailResponse {
  campaign: CampaignRow & { messageTemplate: string };
  stats: {
    total: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    failed: number;
    skipped: number;
    bookings: number;
    revenue: number;
    estimatedCost: number;
    roi: number | null;
    openRate: number | null;
    clickRate: number | null;
    deliveryRate: number | null;
  };
  messages: CampaignMessageRow[];
}

export interface SendRunSummaryResponse {
  summary: {
    campaignId: string;
    audienceSize: number;
    eligible: number;
    sent: number;
    simulated?: number;
    failed: number;
    skipped: number;
    skippedReasons: Record<string, number>;
    rateLimited: number;
    frequencyLimited?: number;
    providerMode: "SIMULATION" | "LIVE";
    truncated: boolean;
  };
}

export interface AnalyticsOverview {
  stats: {
    total: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    failed: number;
    skipped: number;
    bookings: number;
    revenue: number;
    estimatedCost: number;
    roi: number | null;
    openRate: number | null;
    clickRate: number | null;
    deliveryRate: number | null;
  };
  providerMode: { mode: "SIMULATION" | "LIVE"; whatsapp: boolean; sms: boolean; email: boolean };
  topCampaigns: {
    id: string;
    name: string;
    status: string;
    sent: number;
    bookings: number;
    revenue: number;
  }[];
  segmentSizes: { name: string; color: string | null; count: number }[];
  consent: { totalCustomers: number; optedIn: number; optedOut: number; unreachable: number };
}

// ---------------- Phase 3 types ----------------

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT" | "CUSTOMER_SPECIFIC" | "ONE_TIME";
  discountValue: number;
  minimumOrder: number | null;
  maximumDiscount: number | null;
  validFrom: string | null;
  validUntil: string | null;
  usageLimit: number;
  customerLimit: number;
  active: boolean;
  totalRedemptions: number;
  totalDiscount: number;
  redemptionsCount: number;
  createdAt: string;
}

export interface CouponsResponse {
  coupons: CouponRow[];
}

export interface CouponValidationResponse {
  valid: boolean;
  reason?: string;
  code?: string;
  discountType?: string;
  discountValue?: number;
  discount?: number;
  finalAmount?: number;
}

// ---------------- Phase 4 types ----------------

export interface AutomationRuleRow {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  waitDays: number;
  conditions: string | null;
  actions: string;
  channels: string;
  messageTemplate: string | null;
  offer: string | null;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED" | "FAILED";
  runsCount: number;
  lastRunAt: string | null;
  executionsCount: number;
  createdAt: string;
}

export interface AutomationsResponse {
  automations: AutomationRuleRow[];
  recentExecutions: {
    id: string;
    automation: { name: string; trigger: string };
    customer: { name: string; phone: string };
    trigger: string;
    status: string;
    scheduledAt: string;
    executedAt: string | null;
    failureReason: string | null;
    result: string | null;
  }[];
  stats: { totalExecutionsToday: number };
}

export interface RestaurantVisitRow {
  id: string;
  customerId: string;
  customer: { id: string; name: string; phone: string };
  visitDate: string;
  tableNumber: string | null;
  guests: number;
  orderAmount: number;
  foodCategory: string | null;
  favouriteItems: string | null;
  source: string;
  notes: string | null;
}

export interface RestaurantVisitsResponse {
  visits: RestaurantVisitRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface RestaurantLeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  phone: string;
  totalRestaurantVisits: number;
  totalRestaurantSpend: number;
  lastRestaurantVisit: string | null;
  vip: boolean;
}

export interface ScoringLeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  phone: string;
  score: number;
  leadScore: number;
  leadTier: "COLD" | "WARM" | "HOT" | "VERY_HOT";
  rfm: { recency: number; frequency: number; monetary: number };
  totalVisits: number;
}

// ---------------- Phase 6 types ----------------

export interface SuperAdminHotelRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  timezone: string | null;
  currency: string | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  plan: { id: string; name: string; monthlyPrice: number } | null;
  owner: { id: string; name: string; email: string } | null;
  counts: {
    customers: number;
    staff: number;
    campaigns: number;
    visits: number;
    restaurantVisits: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SuperAdminHotelsResponse {
  hotels: SuperAdminHotelRow[];
  plans: { id: string; name: string; description: string | null; monthlyPrice: number }[];
}

export interface PlatformStats {
  totalHotels: number;
  activeHotels: number;
  suspendedHotels: number;
  totalCustomers: number;
  restaurantCustomers: number;
  messagesSent: number;
  activeCampaigns: number;
  monthlyRevenue: number;
  failedCampaigns: number;
  // Phase 10 — SaaS business KPIs
  arr: number;
  trialingSubscriptions: number;
  graceSubscriptions: number;
  expiredSubscriptions: number;
  cancelledSubscriptions: number;
  activeSubscriptions: number;
  trialConversionRate: number;
  churnRate: number;
  lifetimeCollected: number;
  totalUsers: number;
  activeUsers: number;
  activeHotelAdmins: number;
  apiRequests: number;
  aiRequests: number;
}

export interface FeatureFlagRow {
  id: string;
  hotelId: string;
  featureKey: string;
  enabled: boolean;
  updatedAt: string;
}

export interface UsageSummary {
  customers: number;
  customersLimit: number;
  customersUsed: number;
  customersRemaining: number;
  customersPercent: number;
  messages: number;
  messagesLimit: number;
  messagesUsed: number;
  messagesRemaining: number;
  messagesPercent: number;
  campaigns: number;
  campaignsLimit: number;
  campaignsUsed: number;
  campaignsRemaining: number;
  campaignsPercent: number;
  staff: number;
  staffLimit: number;
  staffUsed: number;
  staffRemaining: number;
  staffPercent: number;
  storageMb: number;
  storageMbLimit: number;
  storagePercent: number;
  automations: number;
  apiRequests: number;
  aiRequests: number;
  aiUsageLimit: number;
}

export interface SystemHealthCheck {
  subsystem: string;
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  detail: string;
}

export interface SupportSessionRow {
  id: string;
  hotel: { id: string; name: string | null };
  adminUser: { name: string; email: string };
  reason: string;
  durationMinutes: number;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  status: "REQUESTED" | "ACTIVE" | "EXPIRED" | "ENDED";
}

// ---------------- Phase 8.1 — platform audit (Super Admin) ----------------

export interface PlatformAuditLogRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: string | null;
  hotel: { name: string } | null;
  user: { name: string; email: string; role: string } | null;
  createdAt: string;
}

export interface PlatformAuditLogsResponse {
  logs: PlatformAuditLogRow[];
  actions: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface IntegrationRow {
  id: string;
  type: string;
  name: string;
  // Recheck fix (F04/G): SAVED_UNVERIFIED and VERIFIED are honest connection
  // states — saving credentials alone never claims CONNECTED, and only a
  // real provider check promotes to VERIFIED.
  status: "CONNECTED" | "DISCONNECTED" | "ERROR" | "PENDING" | "SAVED_UNVERIFIED" | "VERIFIED";
  enabled: boolean;
  hasCredentials?: boolean;
  credentialEncrypted?: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface NotificationRow {
  id: string;
  level: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  title: string;
  message: string;
  read: boolean;
  metadata: string | null;
  createdAt: string;
}

export interface LeadEventRow {
  id: string;
  type: string;
  points: number;
  campaignName: string | null;
  metadata: string | null;
  createdAt: string;
}

export interface TimelineEntryOut {
  type: string;
  label: string;
  timestamp: string;
  detail?: string;
  amount?: number;
}

// ---------------- Phase 6.3 types (restaurant growth) ----------------

export interface LoyaltySettingsDto {
  enabled: boolean;
  mode: "POINTS" | "VISITS";
  pointsPer100: number;
  pointsPerVisit: number;
  pointsForReward: number;
  rewardValue: number;
  signupBonus: number;
  silverTierSpend: number;
  goldTierSpend: number;
  vipTierSpend: number;
}

export interface LoyaltyAccountRow {
  id: string;
  customerId: string;
  name: string;
  phone: string;
  vip: boolean;
  points: number;
  lifetimePoints: number;
  lifetimeSpend: number;
  visitsCounted: number;
  tier: string;
  updatedAt: string;
}

export interface LoyaltyResponse {
  settings: LoyaltySettingsDto;
  stats: {
    members: number;
    totalPointsOutstanding: number;
    totalLifetimeSpend: number;
    tierCounts: Record<string, number>;
  };
  accounts: LoyaltyAccountRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface LoyaltyTxnRow {
  id: string;
  type: string;
  points: number;
  reason: string | null;
  balanceAfter: number;
  createdAt: string;
}

export interface QrCodeRow {
  id: string;
  code: string;
  type: "MENU" | "LOYALTY" | "FEEDBACK" | "ORDER";
  label: string | null;
  active: boolean;
  scans: number;
  joins: number;
  lastScanAt: string | null;
  createdAt: string;
  url: string;
}

export interface QrCodesResponse {
  qrCodes: QrCodeRow[];
}

export interface TemplateRow {
  id: string;
  name: string;
  category: string;
  body: string;
  channels: string[];
  isDefault: boolean;
  // RECHECK FIX (D): WhatsApp provider binding (approval lifecycle +
  // positional variable map) — the send pipeline uses these when the
  // template is APPROVED and bound to a campaign.
  providerTemplateId: string | null;
  languageCode: string | null;
  variableMap: Record<string, string> | null;
  approvalStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplatesResponse {
  templates: TemplateRow[];
  variables: { key: string; description: string }[];
}

export interface FeedbackRow {
  id: string;
  rating: number;
  comment: string | null;
  source: string;
  createdAt: string;
  customer: { id: string; name: string; phone: string } | null;
}

export interface FeedbackResponse {
  feedback: FeedbackRow[];
  stats: { total: number; average: number; distribution: Record<string, number> };
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SettingsResponse {
  settings: {
    marketingFrequencyLimit: number;
    frequencyWindowDays: number;
    consentText: string;
    feedbackEnabled: boolean;
  };
  loyalty: { enabled: boolean; mode: string };
  restaurant: { name: string };
}
