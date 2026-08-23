import { describe, expect, it } from 'vitest'
import {
  NotProvisionedRuAuth,
  RU_AUTH_PROVIDERS,
  RuAuthNotProvisionedError,
  authMethodsFor,
  buildAuthorizeUrl,
  challengeFor,
  createPkcePair,
  randomVerifier,
} from './ruAuth'

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    // The one published pair — if this drifts, every VK ID exchange fails with
    // an opaque server-side error, so it is pinned rather than round-tripped.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('produces verifiers in the RFC length window, URL-safe and unpadded', async () => {
    const v = randomVerifier()
    expect(v.length).toBeGreaterThanOrEqual(43)
    expect(v.length).toBeLessThanOrEqual(128)
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/)
    const pair = await createPkcePair()
    expect(pair.method).toBe('S256')
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
    expect(pair.challenge).not.toContain('=')
  })

  it('is not deterministic across calls', async () => {
    const [a, b] = [await createPkcePair(), await createPkcePair()]
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('authorize URLs', () => {
  const base = {
    clientId: 'client-123',
    redirectUri: 'https://inout.example/auth/callback',
    state: 'st-abc',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  }

  it('builds a VK ID URL on the new id.vk.ru endpoint with PKCE', () => {
    const url = new URL(buildAuthorizeUrl(RU_AUTH_PROVIDERS.vk, base))
    expect(url.origin + url.pathname).toBe('https://id.vk.ru/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(base.codeChallenge)
    // The exact redirect_uri is what VK signs the flow against.
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri)
  })

  it('refuses to build a VK ID URL without PKCE — it is mandatory there', () => {
    expect(() =>
      buildAuthorizeUrl(RU_AUTH_PROVIDERS.vk, { ...base, codeChallenge: undefined }),
    ).toThrow(/requires PKCE/)
  })

  it('builds a Yandex ID URL, which tolerates no PKCE but gets it anyway', () => {
    const without = new URL(
      buildAuthorizeUrl(RU_AUTH_PROVIDERS.yandex, { ...base, codeChallenge: undefined }),
    )
    expect(without.origin + without.pathname).toBe('https://oauth.yandex.ru/authorize')
    expect(without.searchParams.get('code_challenge')).toBeNull()
    const withPkce = new URL(buildAuthorizeUrl(RU_AUTH_PROVIDERS.yandex, base))
    expect(withPkce.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('sends the provider defaults when no scopes are given', () => {
    const url = new URL(buildAuthorizeUrl(RU_AUTH_PROVIDERS.yandex, base))
    expect(url.searchParams.get('scope')).toBe('login:email login:info')
  })
})

describe('the stub adapter', () => {
  const adapter = new NotProvisionedRuAuth(
    RU_AUTH_PROVIDERS.vk,
    'client-123',
    'https://inout.example/auth/callback',
  )

  it('begins for real — a correct, PKCE-protected URL and the verifier to keep', async () => {
    const { url, verifier } = await adapter.begin('st-1')
    expect(await challengeFor(verifier)).toBe(new URL(url).searchParams.get('code_challenge'))
  })

  it('refuses to complete rather than half-working', async () => {
    await expect(adapter.complete()).rejects.toBeInstanceOf(RuAuthNotProvisionedError)
  })
})

describe('offered methods follow deployment config, never locale', () => {
  it('lists everything, marking unconfigured ones unavailable with a reason', () => {
    const methods = authMethodsFor({ google: true, emailOtp: false })
    expect(methods.map((m) => m.id)).toEqual(['google', 'email-otp', 'yandex', 'vk'])
    expect(methods.find((m) => m.id === 'google')?.available).toBe(true)
    for (const m of methods.filter((x) => !x.available)) expect(m.reason).toBeTruthy()
  })

  it('turns a method on the moment a client id exists', () => {
    const methods = authMethodsFor({ google: true, emailOtp: true, yandexClientId: 'ya-1' })
    expect(methods.find((m) => m.id === 'yandex')?.available).toBe(true)
    expect(methods.find((m) => m.id === 'vk')?.available).toBe(false)
  })
})
