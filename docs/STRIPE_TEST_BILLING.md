# Stripe Test Billing Setup

ReadWiseHub billing is implemented for Stripe test mode first. Do not use live Stripe keys until the full checkout, webhook, portal, downgrade, cancellation, payment-failure, replay, and account-deletion lifecycle is verified.

## Required Stripe Inputs

Provide these values before deploying billing:

- Plus recurring test Price ID: `price_1TixixCwoqdewBDXVcK6PjlU`
- Pro recurring test Price ID: `price_1Tixm9CwoqdewBDXyrinApZF`
- Ultimate recurring test Price ID: `price_1Tixn1CwoqdewBDXxAlFehsb`
- Stripe test secret key: `sk_test_...`
- Stripe webhook signing secret after the deployed webhook endpoint is created: `whsec_...`

Do not commit secret values.

## Firebase Configuration

Set non-secret function environment values in `functions/.env` or equivalent Firebase environment configuration:

```text
STRIPE_PLUS_PRICE_ID=price_1TixixCwoqdewBDXVcK6PjlU
STRIPE_PRO_PRICE_ID=price_1Tixm9CwoqdewBDXyrinApZF
STRIPE_ULTIMATE_PRICE_ID=price_1Tixn1CwoqdewBDXxAlFehsb
BILLING_RETURN_URL=https://readwisehub.com/#account
```

Set secrets in Firebase Secret Manager:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY --project readwisehub
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project readwisehub
```

## Webhook Endpoint

After deploying Functions, create a Stripe webhook endpoint in the Stripe Dashboard using the deployed `stripeWebhook` HTTPS URL.

Subscribe at minimum to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `customer.subscription.pending_update_applied`
- `customer.subscription.pending_update_expired`
- `invoice.payment_failed`

The webhook verifies Stripe signatures using the raw request body and stores processed event IDs in `stripeWebhookEvents` for replay/idempotency protection.

## Behavior

- Free users can start Stripe Checkout for Plus, Pro, or Ultimate.
- Users with an existing open Stripe subscription must use the Stripe Customer Portal for plan changes and cancellation.
- Only Stripe subscription status `active` or `trialing` grants paid limits.
- Non-active subscription states fall back to Free limits while preserving Stripe billing metadata.
- Account deletion is blocked while a Stripe subscription is open; the user must manage/cancel billing first.

Current public test-mode tiers:

- Plus: 9.99 EUR/month, 10 books, 180 MB storage, 150 messages/month, product `prod_UiOVIrFA3C1tX4`, price `price_1TixixCwoqdewBDXVcK6PjlU`.
- Pro: 19.99 EUR/month, 20 books, 380 MB storage, 320 messages/month, product `prod_UiOZIU85RfFIRV`, price `price_1Tixm9CwoqdewBDXyrinApZF`.
- Ultimate: 29.99 EUR/month, 50 books, 800 MB storage, 500 messages/month, product `prod_UiOaKGJDScN3tK`, price `price_1Tixn1CwoqdewBDXxAlFehsb`.

## Test Matrix

Test in Stripe test mode before live billing:

- Free to Plus
- Free to Pro
- Free to Ultimate
- Plus to Pro/Ultimate through Customer Portal
- Pro to Plus/Ultimate through Customer Portal, if enabled in Portal settings
- Ultimate to Plus/Pro through Customer Portal, if enabled in Portal settings
- cancel at period end
- immediate cancellation, if enabled
- payment failure
- incomplete or expired Checkout
- webhook replay/idempotency
- account deletion with open Stripe subscription
