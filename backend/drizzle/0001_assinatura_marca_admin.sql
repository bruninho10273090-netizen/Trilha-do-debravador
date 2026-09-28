CREATE TYPE "public"."invoice_status" AS ENUM('pendente', 'paga', 'cancelada', 'estornada');--> statement-breakpoint
CREATE TYPE "public"."plan_interval" AS ENUM('mensal', 'anual');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'ativa', 'cancelada');--> statement-breakpoint
CREATE TABLE "club_logos" (
	"club_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"status" "invoice_status" DEFAULT 'pendente' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_ref" text,
	"payment_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"interval" "plan_interval" NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"max_members" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"plan_id" uuid,
	"status" "subscription_status" DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"billing_name" text,
	"billing_document" text,
	"billing_email" text,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_club_id_unique" UNIQUE("club_id")
);
--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "theme" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
-- clubes que já existiam: o administrador passa a ser quem criou, ou o diretor mais antigo
UPDATE "clubs" c SET "owner_id" = COALESCE(c."created_by", (
  SELECT m."user_id" FROM "memberships" m WHERE m."club_id" = c."id" AND m."role" = 'diretor' ORDER BY m."created_at" LIMIT 1
));--> statement-breakpoint
ALTER TABLE "clubs" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guardian_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guardian_phone" text;--> statement-breakpoint
ALTER TABLE "club_logos" ADD CONSTRAINT "club_logos_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_sub_idx" ON "invoices" USING btree ("subscription_id","created_at");--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- clubes que já existiam ganham o período de teste a partir de agora
INSERT INTO "subscriptions" ("club_id", "status", "trial_ends_at")
SELECT "id", 'trial', now() + interval '14 days' FROM "clubs"
ON CONFLICT ("club_id") DO NOTHING;