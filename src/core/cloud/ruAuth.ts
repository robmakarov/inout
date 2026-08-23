/**
 * RU AUTH ALTERNATIVES — design + the half that can be built today (task P3).
 *
 * WHY. Cloud sharing currently has exactly one door: Google. RU users routinely
 * cannot reach accounts.google.com, so for them the door does not exist —
 * capture, edit and export still work (they are local by design), but no link
 * can ever be created. Two providers an RU user already has an account for fix
 * that, plus one that depends on nothing: email one-time codes.
 *
 * WHAT IS HERE AND WHAT IS NOT. Everything in this file is PURE: the authorize
 * URL each provider expects, and the PKCE pair that protects the round trip.
 * That is the part with real, checkable rules (VK ID mandates PKCE S256; Yandex
 * ID signs against an exact redirect_uri), so it is unit-tested now.
 *
 * The token exchange is deliberately NOT here, and not because it is hard:
 *   · VK ID and Yandex ID hand back THEIR OWN tokens. Supabase will not accept
 *     those — signInWithIdToken only speaks to providers it knows — so a
 *     session has to be minted server-side against the project's JWT secret.
 *     A browser holding that secret would hand every visitor an admin key.
 *   · So the exchange belongs in one server function per provider, deployed
 *     next to the project. That server does not exist yet: cloud provisioning
 *     is still pending (docs/CLOUD_RESET.md steps 2-3, PO's to run).
 * Building a client-side exchange now would mean building it twice and shipping
 * a credential leak in between. The adapter interface below is the contract
 * that server must satisfy; `NotProvisionedRuAuth` is what the app uses until
 * it exists, and it fails loudly rather than pretending.
 *
 * EMAIL-OTP is the odd one out: Supabase implements it natively
 * (signInWithOtp + verifyOtp), no server function and no new provider needed.
 * It is the cheapest RU unblock available and should ship first — the only open
 * question is deliverability of the sending domain to RU mailboxes, which is a
 * provisioning matter, not a code one.
 */

import type { AuthMethod, AuthMethodInfo } from '../types'

export interface RuAuthProviderConfig {
  id: Extract<AuthMethod, 'yandex' | 'vk'>
  label: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  /** VK ID is OAuth 2.1: PKCE is mandatory and there is no client_secret. */
  pkce: 'required' | 'recommended'
  defaultScopes: string[]
}

/**
 * Endpoints as documented by each provider. Yandex ID is OAuth 2.0 on
 * oauth.yandex.ru with userinfo on login.yandex.ru; VK ID moved to OAuth 2.1 on
 * id.vk.ru and is NOT compatible with the legacy oauth.vk.com endpoints.
 */
export const RU_AUTH_PROVIDERS: Record<'yandex' | 'vk', RuAuthProviderConfig> = {
  yandex: {
    id: 'yandex',
    label: 'Yandex ID',
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    userInfoUrl: 'https://login.yandex.ru/info',
    pkce: 'recommended',
    defaultScopes: ['login:email', 'login:info'],
  },
  vk: {
    id: 'vk',
    label: 'VK ID',
    authorizeUrl: 'https://id.vk.ru/authorize',
    tokenUrl: 'https://id.vk.ru/oauth2/auth',
    userInfoUrl: 'https://id.vk.ru/oauth2/user_info',
    pkce: 'required',
    defaultScopes: ['email'],
  },
}

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

const B64URL = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** RFC 7636 §4.1: 43–128 chars from the unreserved set. 32 random bytes → 43. */
export function randomVerifier(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return B64URL(buf)
}

/** RFC 7636 §4.2: challenge = BASE64URL(SHA256(ASCII(verifier))), no padding. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return B64URL(new Uint8Array(digest))
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomVerifier()
  return { verifier, challenge: await challengeFor(verifier), method: 'S256' }
}

export interface AuthorizeUrlParams {
  clientId: string
  /** Must match the registered value EXACTLY — VK ID signs the flow against it
   * and a trailing slash is enough to break the callback. */
  redirectUri: string
  state: string
  codeChallenge?: string
  scopes?: string[]
}

export function buildAuthorizeUrl(
  provider: RuAuthProviderConfig,
  params: AuthorizeUrlParams,
): string {
  if (provider.pkce === 'required' && !params.codeChallenge) {
    throw new Error(`${provider.label} requires PKCE — pass codeChallenge`)
  }
  const url = new URL(provider.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  const scopes = params.scopes ?? provider.defaultScopes
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '))
  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

/**
 * What the server function must implement, one per provider. `begin` is pure
 * and already satisfied by buildAuthorizeUrl above; `complete` is the leg that
 * needs the JWT secret and therefore a server.
 */
export interface RuAuthAdapter {
  readonly provider: RuAuthProviderConfig
  /** Returns the URL to send the browser to, and the verifier to keep. */
  begin(state: string): Promise<{ url: string; verifier: string }>
  /**
   * Exchanges the callback code for an INOUT/Supabase session. Runs against a
   * server function — never in the browser, which must never hold the secret
   * that mints sessions.
   */
  complete(code: string, verifier: string): Promise<void>
}

export class RuAuthNotProvisionedError extends Error {
  constructor(provider: string) {
    super(
      `${provider} sign-in is designed but not provisioned yet — it needs a server-side token exchange (see src/core/cloud/ruAuth.ts).`,
    )
    this.name = 'RuAuthNotProvisionedError'
  }
}

/**
 * The stub the app compiles against today. `begin` is real — it produces a
 * correct, PKCE-protected authorize URL — so the design is exercised rather
 * than merely described; `complete` refuses loudly instead of half-working.
 */
export class NotProvisionedRuAuth implements RuAuthAdapter {
  constructor(
    readonly provider: RuAuthProviderConfig,
    private readonly clientId: string,
    private readonly redirectUri: string,
  ) {}

  async begin(state: string): Promise<{ url: string; verifier: string }> {
    const pkce = await createPkcePair()
    return {
      url: buildAuthorizeUrl(this.provider, {
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        state,
        codeChallenge: pkce.challenge,
      }),
      verifier: pkce.verifier,
    }
  }

  async complete(): Promise<never> {
    throw new RuAuthNotProvisionedError(this.provider.label)
  }
}

/**
 * What the sign-in UI should offer. Availability is a DEPLOYMENT fact (is a
 * client id configured, is the server function deployed), never a guess from
 * the user's locale — an RU user on a working Google connection should keep
 * using it, and a non-RU user who prefers Yandex ID should be allowed to.
 */
export function authMethodsFor(config: {
  google: boolean
  emailOtp: boolean
  yandexClientId?: string
  vkClientId?: string
}): AuthMethodInfo[] {
  return [
    {
      id: 'google',
      label: 'Continue with Google',
      available: config.google,
      reason: config.google ? undefined : 'Cloud sharing is not configured.',
    },
    {
      id: 'email-otp',
      label: 'Email me a code',
      available: config.emailOtp,
      reason: config.emailOtp ? undefined : 'Not enabled for this deployment.',
    },
    {
      id: 'yandex',
      label: 'Continue with Yandex ID',
      available: !!config.yandexClientId,
      reason: config.yandexClientId ? undefined : 'Not configured for this deployment yet.',
    },
    {
      id: 'vk',
      label: 'Continue with VK ID',
      available: !!config.vkClientId,
      reason: config.vkClientId ? undefined : 'Not configured for this deployment yet.',
    },
  ]
}
