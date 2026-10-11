-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'HOTEL_OWNER', 'HOTEL_ADMIN', 'HOTEL_MANAGER', 'MARKETING_MANAGER', 'RESTAURANT_MANAGER', 'FRONT_DESK', 'HOTEL_STAFF');

-- CreateEnum
CREATE TYPE "HotelStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SegmentType" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "SegmentMemberSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'PAUSED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CampaignScheduleType" AS ENUM ('NOW', 'SCHEDULED', 'AUTOMATED');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED', 'SIMULATED');

-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'CUSTOMER_SPECIFIC', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('CUSTOMER_CREATED', 'BOOKING', 'CHECKOUT', 'PAYMENT', 'FEEDBACK', 'CAMPAIGN_SENT', 'CAMPAIGN_OPENED', 'CAMPAIGN_CLICKED', 'CAMPAIGN_REPLIED', 'COUPON_ISSUED', 'COUPON_REDEEMED', 'ADMIN_NOTE', 'SEGMENT_ADDED', 'CONSENT_GRANTED', 'CONSENT_REVOKED', 'BIRTHDAY', 'ANNIVERSARY', 'RESTAURANT_VISIT');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('HOTEL_CHECKOUT', 'RESTAURANT_VISIT', 'INACTIVE_7', 'INACTIVE_15', 'INACTIVE_30', 'BIRTHDAY', 'ANNIVERSARY', 'VIP_THRESHOLD', 'OFFER_UNUSED', 'REPEAT_VISIT', 'SPECIAL_EVENT', 'CAMPAIGN_OPENED', 'CAMPAIGN_CLICKED', 'CAMPAIGN_REPLIED');

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeadEventType" AS ENUM ('MESSAGE_OPENED', 'LINK_CLICKED', 'REPLIED', 'OFFER_VIEWED', 'BOOKING_PAGE_VISITED', 'BOOKING_COMPLETED', 'COUPON_REDEEMED');

-- CreateEnum
CREATE TYPE "RestaurantVisitSource" AS ENUM ('WALK_IN', 'RESERVATION', 'ROOM_GUEST', 'EVENT', 'ONLINE_ORDER', 'QR_MENU', 'WIFI_LOGIN', 'FEEDBACK', 'LOYALTY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'SUSPENDED', 'TRIALING');

-- CreateEnum
CREATE TYPE "SupportSessionStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'EXPIRED', 'ENDED');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('WHATSAPP_CLOUD', 'TWILIO_SMS', 'SMTP', 'STRIPE', 'RAZORPAY', 'ZOMATO', 'SWIGGY', 'POS', 'GOOGLE_CALENDAR', 'CALENDLY', 'CUSTOM_WEBHOOK');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR', 'PENDING');

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "LoyaltyMode" AS ENUM ('POINTS', 'VISITS');

-- CreateEnum
CREATE TYPE "LoyaltyTxnType" AS ENUM ('EARN', 'EARN_VISIT', 'REDEEM', 'ADJUST', 'SIGNUP_BONUS', 'REVERSAL', 'VISIT_ADJUST');

-- CreateEnum
CREATE TYPE "QRCodeType" AS ENUM ('MENU', 'LOYALTY', 'FEEDBACK', 'ORDER');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('WELCOME', 'THANK_YOU', 'COME_BACK', 'BIRTHDAY', 'SPECIAL_OFFER', 'FESTIVAL_OFFER', 'LOYALTY_REWARD', 'INACTIVE_WINBACK', 'VIP_APPRECIATION');

-- CreateEnum
CREATE TYPE "BackgroundJobType" AS ENUM ('CAMPAIGN_SEND', 'CSV_EXPORT');

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ActivationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'OWNER_INVITATION',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hotel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "HotelStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "website" TEXT,
    "gstin" TEXT,
    "timezone" TEXT DEFAULT 'Asia/Kolkata',
    "currency" TEXT DEFAULT 'INR',
    "planId" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,

    CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'HOTEL_STAFF',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "emailVerified" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentTimestamp" TIMESTAMP(3),
    "consentSource" TEXT,
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "roomPreference" TEXT,
    "foodPreference" TEXT,
    "location" TEXT,
    "birthday" TIMESTAMP(3),
    "anniversary" TIMESTAMP(3),
    "source" TEXT,
    "notes" TEXT,
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false,
    "smsOptIn" BOOLEAN NOT NULL DEFAULT false,
    "emailOptIn" BOOLEAN NOT NULL DEFAULT false,
    "preferredRoom" TEXT,
    "preferredService" TEXT,
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "recencyScore" INTEGER NOT NULL DEFAULT 0,
    "frequencyScore" INTEGER NOT NULL DEFAULT 0,
    "monetaryScore" INTEGER NOT NULL DEFAULT 0,
    "customerValueScore" INTEGER NOT NULL DEFAULT 0,
    "leadScore" INTEGER NOT NULL DEFAULT 0,
    "leadTier" TEXT,
    "favouriteItems" TEXT,
    "favouriteCategory" TEXT,
    "diningFrequency" INTEGER NOT NULL DEFAULT 0,
    "lastRestaurantVisit" TIMESTAMP(3),
    "totalRestaurantVisits" INTEGER NOT NULL DEFAULT 0,
    "totalRestaurantSpend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "checkin" TIMESTAMP(3) NOT NULL,
    "checkout" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "amount" DOUBLE PRECISION,
    "roomType" TEXT,
    "guests" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "SegmentType" NOT NULL DEFAULT 'MANUAL',
    "rule" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "visitThreshold" INTEGER,
    "spendThreshold" DOUBLE PRECISION,
    "inactiveDays" INTEGER,
    "lostDays" INTEGER,
    "domain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentMember" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "source" "SegmentMemberSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduleType" "CampaignScheduleType" NOT NULL DEFAULT 'NOW',
    "scheduledAt" TIMESTAMP(3),
    "segmentId" TEXT,
    "channels" TEXT NOT NULL,
    "offer" TEXT,
    "couponId" TEXT,
    "messageTemplate" TEXT NOT NULL,
    "followUpStepId" TEXT,
    "createdById" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "campaignType" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "frequencyCapPerCustomer" INTEGER NOT NULL DEFAULT 1,
    "frequencyWindowDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMessage" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "personalizedMessage" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "bookingLinked" BOOLEAN NOT NULL DEFAULT false,
    "bookingAmount" DOUBLE PRECISION,
    "bookingAt" TIMESTAMP(3),
    "attributedRevenue" DOUBLE PRECISION DEFAULT 0,
    "idempotencyKey" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastTriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpStep" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "messageTemplate" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "CouponDiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minimumOrder" DOUBLE PRECISION,
    "maximumDiscount" DOUBLE PRECISION,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "usageLimit" INTEGER NOT NULL DEFAULT 0,
    "customerLimit" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "totalRedemptions" INTEGER NOT NULL DEFAULT 0,
    "totalDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "orderId" TEXT,
    "orderAmount" DOUBLE PRECISION,
    "discountAmount" DOUBLE PRECISION NOT NULL,
    "redemptionSlot" INTEGER NOT NULL DEFAULT 0,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "TimelineEventType" NOT NULL,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "amount" DOUBLE PRECISION,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Journey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyStep" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "messageTemplate" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "offer" TEXT,
    "couponId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "JourneyStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "AutomationTrigger" NOT NULL,
    "waitDays" INTEGER NOT NULL DEFAULT 0,
    "conditions" TEXT,
    "actions" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "messageTemplate" TEXT,
    "offer" TEXT,
    "couponId" TEXT,
    "status" "AutomationStatus" NOT NULL DEFAULT 'DRAFT',
    "runsCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationExecution" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "AutomationExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "campaignId" TEXT,
    "messageId" TEXT,
    "userId" TEXT,
    "type" "LeadEventType" NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantVisit" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "visitDate" TIMESTAMP(3) NOT NULL,
    "tableNumber" TEXT,
    "guests" INTEGER NOT NULL DEFAULT 1,
    "orderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "foodCategory" TEXT,
    "favouriteItems" TEXT,
    "source" "RestaurantVisitSource" NOT NULL DEFAULT 'WALK_IN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantOrder" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "restaurantVisitId" TEXT,
    "orderId" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "monthlyPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "customerLimit" INTEGER NOT NULL DEFAULT 0,
    "campaignLimit" INTEGER NOT NULL DEFAULT 0,
    "messageLimit" INTEGER NOT NULL DEFAULT 0,
    "staffLimit" INTEGER NOT NULL DEFAULT 0,
    "aiUsageLimit" INTEGER NOT NULL DEFAULT 0,
    "storageMb" INTEGER NOT NULL DEFAULT 100,
    "apiAccess" BOOLEAN NOT NULL DEFAULT false,
    "advancedAnalytics" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAt" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantFeature" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "customers" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "campaigns" INTEGER NOT NULL DEFAULT 0,
    "automations" INTEGER NOT NULL DEFAULT 0,
    "apiRequests" INTEGER NOT NULL DEFAULT 0,
    "aiRequests" INTEGER NOT NULL DEFAULT 0,
    "storageMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "staff" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "status" "SupportSessionStatus" NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "type" "IntegrationType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "credentials" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "level" "NotificationLevel" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltySettings" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mode" "LoyaltyMode" NOT NULL DEFAULT 'POINTS',
    "pointsPer100" INTEGER NOT NULL DEFAULT 10,
    "pointsPerVisit" INTEGER NOT NULL DEFAULT 50,
    "pointsForReward" INTEGER NOT NULL DEFAULT 500,
    "rewardValue" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "signupBonus" INTEGER NOT NULL DEFAULT 50,
    "silverTierSpend" DOUBLE PRECISION NOT NULL DEFAULT 5000,
    "goldTierSpend" DOUBLE PRECISION NOT NULL DEFAULT 15000,
    "vipTierSpend" DOUBLE PRECISION NOT NULL DEFAULT 50000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeSpend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "visitsCounted" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'BRONZE',
    "lastAwardVisitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "LoyaltyTxnType" NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT,
    "visitId" TEXT,
    "actorId" TEXT,
    "idempotencyKey" TEXT,
    "balanceBefore" INTEGER NOT NULL DEFAULT 0,
    "balanceAfter" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QRCode" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "QRCodeType" NOT NULL DEFAULT 'LOYALTY',
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "scans" INTEGER NOT NULL DEFAULT 0,
    "joins" INTEGER NOT NULL DEFAULT 0,
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QRCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "customerId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "source" TEXT NOT NULL DEFAULT 'QR_PAGE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "TemplateCategory" NOT NULL DEFAULT 'SPECIAL_OFFER',
    "body" TEXT NOT NULL,
    "channels" TEXT NOT NULL DEFAULT '["WHATSAPP"]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelSettings" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "marketingFrequencyLimit" INTEGER NOT NULL DEFAULT 3,
    "frequencyWindowDays" INTEGER NOT NULL DEFAULT 30,
    "consentText" TEXT NOT NULL DEFAULT 'I want to receive offers and discounts from this restaurant.',
    "feedbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT,
    "type" "BackgroundJobType" NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" TEXT NOT NULL,
    "result" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationToken_tokenHash_key" ON "ActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ActivationToken_userId_idx" ON "ActivationToken"("userId");

-- CreateIndex
CREATE INDEX "ActivationToken_expiresAt_idx" ON "ActivationToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Hotel_status_idx" ON "Hotel"("status");

-- CreateIndex
CREATE INDEX "Hotel_planId_idx" ON "Hotel"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_hotelId_idx" ON "User"("hotelId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "Customer_hotelId_idx" ON "Customer"("hotelId");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Customer_marketingConsent_idx" ON "Customer"("marketingConsent");

-- CreateIndex
CREATE INDEX "Customer_status_idx" ON "Customer"("status");

-- CreateIndex
CREATE INDEX "Customer_vip_idx" ON "Customer"("vip");

-- CreateIndex
CREATE INDEX "Customer_leadTier_idx" ON "Customer"("leadTier");

-- CreateIndex
CREATE INDEX "Customer_birthday_idx" ON "Customer"("birthday");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_hotelId_phone_key" ON "Customer"("hotelId", "phone");

-- CreateIndex
CREATE INDEX "Visit_hotelId_idx" ON "Visit"("hotelId");

-- CreateIndex
CREATE INDEX "Visit_customerId_idx" ON "Visit"("customerId");

-- CreateIndex
CREATE INDEX "Visit_checkin_idx" ON "Visit"("checkin");

-- CreateIndex
CREATE INDEX "Visit_checkout_idx" ON "Visit"("checkout");

-- CreateIndex
CREATE INDEX "AuditLog_hotelId_idx" ON "AuditLog"("hotelId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuthAttempt_email_createdAt_idx" ON "AuthAttempt"("email", "createdAt");

-- CreateIndex
CREATE INDEX "Segment_hotelId_idx" ON "Segment"("hotelId");

-- CreateIndex
CREATE INDEX "Segment_type_idx" ON "Segment"("type");

-- CreateIndex
CREATE INDEX "Segment_domain_idx" ON "Segment"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Segment_hotelId_name_key" ON "Segment"("hotelId", "name");

-- CreateIndex
CREATE INDEX "SegmentMember_customerId_idx" ON "SegmentMember"("customerId");

-- CreateIndex
CREATE INDEX "SegmentMember_segmentId_idx" ON "SegmentMember"("segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentMember_segmentId_customerId_key" ON "SegmentMember"("segmentId", "customerId");

-- CreateIndex
CREATE INDEX "Campaign_hotelId_idx" ON "Campaign"("hotelId");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "Campaign_campaignType_idx" ON "Campaign"("campaignType");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_followUpStepId_key" ON "Campaign"("followUpStepId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMessage_idempotencyKey_key" ON "CampaignMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CampaignMessage_hotelId_idx" ON "CampaignMessage"("hotelId");

-- CreateIndex
CREATE INDEX "CampaignMessage_campaignId_idx" ON "CampaignMessage"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignMessage_customerId_idx" ON "CampaignMessage"("customerId");

-- CreateIndex
CREATE INDEX "CampaignMessage_status_idx" ON "CampaignMessage"("status");

-- CreateIndex
CREATE INDEX "CampaignMessage_sentAt_idx" ON "CampaignMessage"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMessage_campaignId_customerId_channel_key" ON "CampaignMessage"("campaignId", "customerId", "channel");

-- CreateIndex
CREATE INDEX "FollowUpStep_hotelId_idx" ON "FollowUpStep"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpStep_hotelId_offsetDays_key" ON "FollowUpStep"("hotelId", "offsetDays");

-- CreateIndex
CREATE INDEX "Coupon_hotelId_idx" ON "Coupon"("hotelId");

-- CreateIndex
CREATE INDEX "Coupon_code_idx" ON "Coupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_hotelId_code_key" ON "Coupon"("hotelId", "code");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_idx" ON "CouponRedemption"("couponId");

-- CreateIndex
CREATE INDEX "CouponRedemption_customerId_idx" ON "CouponRedemption"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_customerId_orderId_key" ON "CouponRedemption"("couponId", "customerId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_customerId_redemptionSlot_key" ON "CouponRedemption"("couponId", "customerId", "redemptionSlot");

-- CreateIndex
CREATE INDEX "TimelineEvent_customerId_idx" ON "TimelineEvent"("customerId");

-- CreateIndex
CREATE INDEX "TimelineEvent_hotelId_idx" ON "TimelineEvent"("hotelId");

-- CreateIndex
CREATE INDEX "TimelineEvent_type_idx" ON "TimelineEvent"("type");

-- CreateIndex
CREATE INDEX "TimelineEvent_createdAt_idx" ON "TimelineEvent"("createdAt");

-- CreateIndex
CREATE INDEX "Journey_hotelId_idx" ON "Journey"("hotelId");

-- CreateIndex
CREATE INDEX "JourneyStep_journeyId_idx" ON "JourneyStep"("journeyId");

-- CreateIndex
CREATE INDEX "AutomationRule_hotelId_idx" ON "AutomationRule"("hotelId");

-- CreateIndex
CREATE INDEX "AutomationRule_trigger_idx" ON "AutomationRule"("trigger");

-- CreateIndex
CREATE INDEX "AutomationRule_status_idx" ON "AutomationRule"("status");

-- CreateIndex
CREATE INDEX "AutomationExecution_automationId_idx" ON "AutomationExecution"("automationId");

-- CreateIndex
CREATE INDEX "AutomationExecution_hotelId_idx" ON "AutomationExecution"("hotelId");

-- CreateIndex
CREATE INDEX "AutomationExecution_customerId_idx" ON "AutomationExecution"("customerId");

-- CreateIndex
CREATE INDEX "AutomationExecution_status_idx" ON "AutomationExecution"("status");

-- CreateIndex
CREATE INDEX "AutomationExecution_scheduledAt_idx" ON "AutomationExecution"("scheduledAt");

-- CreateIndex
CREATE INDEX "LeadEvent_customerId_idx" ON "LeadEvent"("customerId");

-- CreateIndex
CREATE INDEX "LeadEvent_hotelId_idx" ON "LeadEvent"("hotelId");

-- CreateIndex
CREATE INDEX "LeadEvent_type_idx" ON "LeadEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "LeadEvent_customerId_type_messageId_key" ON "LeadEvent"("customerId", "type", "messageId");

-- CreateIndex
CREATE INDEX "RestaurantVisit_hotelId_idx" ON "RestaurantVisit"("hotelId");

-- CreateIndex
CREATE INDEX "RestaurantVisit_customerId_idx" ON "RestaurantVisit"("customerId");

-- CreateIndex
CREATE INDEX "RestaurantVisit_visitDate_idx" ON "RestaurantVisit"("visitDate");

-- CreateIndex
CREATE INDEX "RestaurantVisit_source_idx" ON "RestaurantVisit"("source");

-- CreateIndex
CREATE INDEX "RestaurantOrder_hotelId_idx" ON "RestaurantOrder"("hotelId");

-- CreateIndex
CREATE INDEX "RestaurantOrder_customerId_idx" ON "RestaurantOrder"("customerId");

-- CreateIndex
CREATE INDEX "RestaurantOrder_restaurantVisitId_idx" ON "RestaurantOrder"("restaurantVisitId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- CreateIndex
CREATE INDEX "Subscription_hotelId_idx" ON "Subscription"("hotelId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "TenantFeature_hotelId_idx" ON "TenantFeature"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantFeature_hotelId_featureKey_key" ON "TenantFeature"("hotelId", "featureKey");

-- CreateIndex
CREATE INDEX "UsageRecord_hotelId_idx" ON "UsageRecord"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_hotelId_period_key" ON "UsageRecord"("hotelId", "period");

-- CreateIndex
CREATE INDEX "SupportSession_hotelId_idx" ON "SupportSession"("hotelId");

-- CreateIndex
CREATE INDEX "SupportSession_adminUserId_idx" ON "SupportSession"("adminUserId");

-- CreateIndex
CREATE INDEX "SupportSession_status_idx" ON "SupportSession"("status");

-- CreateIndex
CREATE INDEX "SupportSession_expiresAt_idx" ON "SupportSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Integration_hotelId_idx" ON "Integration"("hotelId");

-- CreateIndex
CREATE INDEX "Integration_type_idx" ON "Integration"("type");

-- CreateIndex
CREATE INDEX "Integration_status_idx" ON "Integration"("status");

-- CreateIndex
CREATE INDEX "Notification_hotelId_idx" ON "Notification"("hotelId");

-- CreateIndex
CREATE INDEX "Notification_read_idx" ON "Notification"("read");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltySettings_hotelId_key" ON "LoyaltySettings"("hotelId");

-- CreateIndex
CREATE INDEX "LoyaltySettings_hotelId_idx" ON "LoyaltySettings"("hotelId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_hotelId_idx" ON "LoyaltyAccount"("hotelId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_customerId_idx" ON "LoyaltyAccount"("customerId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_tier_idx" ON "LoyaltyAccount"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_hotelId_customerId_key" ON "LoyaltyAccount"("hotelId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_idempotencyKey_key" ON "LoyaltyTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_hotelId_idx" ON "LoyaltyTransaction"("hotelId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_accountId_idx" ON "LoyaltyTransaction"("accountId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_customerId_idx" ON "LoyaltyTransaction"("customerId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_visitId_idx" ON "LoyaltyTransaction"("visitId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_createdAt_idx" ON "LoyaltyTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QRCode_code_key" ON "QRCode"("code");

-- CreateIndex
CREATE INDEX "QRCode_hotelId_idx" ON "QRCode"("hotelId");

-- CreateIndex
CREATE INDEX "QRCode_type_idx" ON "QRCode"("type");

-- CreateIndex
CREATE INDEX "Feedback_hotelId_idx" ON "Feedback"("hotelId");

-- CreateIndex
CREATE INDEX "Feedback_customerId_idx" ON "Feedback"("customerId");

-- CreateIndex
CREATE INDEX "Feedback_rating_idx" ON "Feedback"("rating");

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

-- CreateIndex
CREATE INDEX "MessageTemplate_hotelId_idx" ON "MessageTemplate"("hotelId");

-- CreateIndex
CREATE INDEX "MessageTemplate_category_idx" ON "MessageTemplate"("category");

-- CreateIndex
CREATE UNIQUE INDEX "HotelSettings_hotelId_key" ON "HotelSettings"("hotelId");

-- CreateIndex
CREATE INDEX "HotelSettings_hotelId_idx" ON "HotelSettings"("hotelId");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_runAt_idx" ON "BackgroundJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "BackgroundJob_hotelId_idx" ON "BackgroundJob"("hotelId");

-- CreateIndex
CREATE INDEX "BackgroundJob_type_idx" ON "BackgroundJob"("type");

-- CreateIndex
CREATE INDEX "BackgroundJob_createdAt_idx" ON "BackgroundJob"("createdAt");

-- AddForeignKey
ALTER TABLE "ActivationToken" ADD CONSTRAINT "ActivationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hotel" ADD CONSTRAINT "Hotel_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentMember" ADD CONSTRAINT "SegmentMember_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentMember" ADD CONSTRAINT "SegmentMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_followUpStepId_fkey" FOREIGN KEY ("followUpStepId") REFERENCES "FollowUpStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMessage" ADD CONSTRAINT "CampaignMessage_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMessage" ADD CONSTRAINT "CampaignMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMessage" ADD CONSTRAINT "CampaignMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpStep" ADD CONSTRAINT "FollowUpStep_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyStep" ADD CONSTRAINT "JourneyStep_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantVisit" ADD CONSTRAINT "RestaurantVisit_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantVisit" ADD CONSTRAINT "RestaurantVisit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrder" ADD CONSTRAINT "RestaurantOrder_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrder" ADD CONSTRAINT "RestaurantOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrder" ADD CONSTRAINT "RestaurantOrder_restaurantVisitId_fkey" FOREIGN KEY ("restaurantVisitId") REFERENCES "RestaurantVisit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantFeature" ADD CONSTRAINT "TenantFeature_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltySettings" ADD CONSTRAINT "LoyaltySettings_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QRCode" ADD CONSTRAINT "QRCode_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelSettings" ADD CONSTRAINT "HotelSettings_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

