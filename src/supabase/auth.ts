import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Database } from '../../supabase/database.types.ts';
import { isTauriRuntime } from '../platform/capabilities.ts';
import { getConfiguredSupabaseProject, getSupabaseClient, getSupabaseConfigState } from './client.ts';
import { SUPABASE_CALLBACK_URL, SUPABASE_PROVIDER, type SupabaseConfigState } from './config.ts';

const PENDING_FLOW_MAX_AGE_MS = 10 * 60 * 1000;
const pendingFlowKey = (projectRef: string) => `backlogger.auth.pending.${projectRef}`;

export type AuthStatus = 'loading' | 'signed-out' | 'signing-in' | 'signed-in';

export interface AuthState {
  status: AuthStatus;
  configured: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
}

export type AuthStateListener = (state: AuthState) => void;

export type AuthCallback =
  | { kind: 'code'; code: string; flowId: string | null }
  | { kind: 'error'; message: string };

export class AuthCallbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCallbackValidationError';
  }
}

let state: AuthState = {
  status: 'loading',
  configured: false,
  userId: null,
  email: null,
  error: null,
};
let initialization: Promise<void> | null = null;
let authClient: SupabaseClient<Database> | null = null;
let authUnsubscribe: (() => void) | null = null;
let deepLinkUnsubscribe: (() => void) | null = null;
let pendingFlowInMemory = false;
let flowStartedFrom: AuthStatus = 'signed-out';
const consumedCodes = new Set<string>();
const listeners = new Set<AuthStateListener>();

function notify() {
  const snapshot = getAuthState();
  listeners.forEach(listener => listener(snapshot));
}

function updateState(next: Partial<AuthState>) {
  state = { ...state, ...next };
  notify();
}

function sessionState(session: Session | null, configured: boolean, error: string | null = null): AuthState {
  const user = session?.user;
  return {
    status: user?.id ? 'signed-in' : 'signed-out',
    configured,
    userId: user?.id ?? null,
    email: typeof user?.email === 'string' && user.email.trim() ? user.email : null,
    error,
  };
}

function applySession(session: Session | null, configured = state.configured) {
  state = sessionState(session, configured, null);
  notify();
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function setPendingFlow(projectRef: string) {
  pendingFlowInMemory = true;
  const storage = localStorageOrNull();
  try {
    storage?.setItem(pendingFlowKey(projectRef), String(Date.now()));
  } catch {
    // The in-memory marker still protects an already-running process. A
    // cold-start callback requires normal Tauri localStorage persistence.
  }
}

function clearPendingFlow(projectRef: string) {
  pendingFlowInMemory = false;
  const storage = localStorageOrNull();
  try {
    storage?.removeItem(pendingFlowKey(projectRef));
  } catch {
    // A stale marker is harmless when storage is unavailable.
  }
}

function hasPendingFlow(projectRef: string): boolean {
  if (pendingFlowInMemory) return true;
  const storage = localStorageOrNull();
  if (!storage) return false;
  try {
    const raw = storage.getItem(pendingFlowKey(projectRef));
    const startedAt = raw ? Number(raw) : NaN;
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > PENDING_FLOW_MAX_AGE_MS) {
      if (raw) storage.removeItem(pendingFlowKey(projectRef));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeOAuthError(error: string | null): string {
  return error === 'access_denied'
    ? 'Google sign-in was cancelled.'
    : 'Google sign-in could not be completed. Please try again.';
}

export function sanitizeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/cancel|denied|abort/i.test(message)) return 'Google sign-in was cancelled.';
  if (/network|fetch|offline|timeout|unreachable|connection/i.test(message)) return 'Could not reach Supabase. Check your connection and try again.';
  if (/configur/i.test(message)) return 'Sync configuration is unavailable.';
  return 'Google sign-in could not be completed. Please try again.';
}

/** Validate the exact custom-scheme callback without exposing its query values. */
export function parseAuthCallbackUrl(rawUrl: string): AuthCallback {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AuthCallbackValidationError('The sign-in callback URL is invalid.');
  }
  if (
    url.protocol !== 'backlogger:'
    || url.hostname !== 'auth'
    || url.pathname !== '/callback'
    || url.port
    || url.username
    || url.password
    || url.hash
  ) {
    throw new AuthCallbackValidationError('The sign-in callback URL is not supported.');
  }

  const codes = url.searchParams.getAll('code');
  const errors = url.searchParams.getAll('error');
  if (codes.length > 1 || errors.length > 1 || (codes.length > 0 && errors.length > 0)) {
    throw new AuthCallbackValidationError('The sign-in callback contains duplicate parameters.');
  }
  if (errors.length === 1) {
    return { kind: 'error', message: safeOAuthError(errors[0]) };
  }
  const code = codes[0]?.trim() ?? '';
  if (!code) throw new AuthCallbackValidationError('The sign-in callback did not contain a code.');
  if (code.length > 4096) throw new AuthCallbackValidationError('The sign-in callback code is invalid.');
  const flowId = url.searchParams.get('sb_flow_id')?.trim() || null;
  return { kind: 'code', code, flowId };
}

function isSupabaseAuthorizeUrl(rawUrl: string, projectRef: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname === `${projectRef}.supabase.co`
      && url.pathname === '/auth/v1/authorize';
  } catch {
    return false;
  }
}

async function openAuthorizationUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }
  if (typeof window === 'undefined' || typeof window.open !== 'function') {
    throw new Error('An external browser is unavailable.');
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error('The external browser could not be opened.');
}

function configuredState(): SupabaseConfigState {
  return getSupabaseConfigState();
}

export function getAuthState(): AuthState {
  return { ...state };
}

export function subscribeAuthState(listener: AuthStateListener): () => void {
  listeners.add(listener);
  listener(getAuthState());
  return () => listeners.delete(listener);
}

export async function startGoogleSignIn(): Promise<void> {
  const configState = configuredState();
  if (!configState.configured) {
    updateState({ status: 'signed-out', configured: false, error: configState.message });
    return;
  }
  const client = getSupabaseClient();
  if (!client) {
    updateState({ status: 'signed-out', configured: true, error: 'Sync configuration is unavailable.' });
    return;
  }
  if (state.status === 'signing-in') return;

  authClient = client;
  flowStartedFrom = state.status;
  setPendingFlow(configState.config.projectRef);
  updateState({ status: 'signing-in', configured: true, error: null });
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: SUPABASE_PROVIDER,
      options: {
        redirectTo: SUPABASE_CALLBACK_URL,
        skipBrowserRedirect: true,
        scopes: 'openid email profile',
      },
    });
    if (error) throw error;
    if (!data.url || !isSupabaseAuthorizeUrl(data.url, configState.config.projectRef)) {
      throw new Error('Supabase returned an unexpected authorization URL.');
    }
    await openAuthorizationUrl(data.url);
  } catch (error) {
    clearPendingFlow(configState.config.projectRef);
    updateState({ status: flowStartedFrom === 'signed-in' ? 'signed-in' : 'signed-out', error: sanitizeAuthError(error) });
    throw new Error(sanitizeAuthError(error));
  }
}

export function cancelGoogleSignIn(): void {
  const project = getConfiguredSupabaseProject();
  if (project) clearPendingFlow(project.projectRef);
  updateState({
    status: flowStartedFrom === 'signed-in' ? 'signed-in' : 'signed-out',
    error: null,
  });
}

export async function handleAuthCallback(rawUrl: string): Promise<boolean> {
  const callback = parseAuthCallbackUrl(rawUrl);
  const configState = configuredState();
  if (!configState.configured) {
    updateState({ status: 'signed-out', configured: false, error: configState.message });
    return false;
  }
  const projectRef = configState.config.projectRef;
  if (callback.kind === 'code' && consumedCodes.has(callback.code)) {
    throw new AuthCallbackValidationError('This sign-in callback has already been handled.');
  }
  if (!hasPendingFlow(projectRef)) {
    throw new AuthCallbackValidationError('This sign-in callback was not requested by Backlogger.');
  }
  clearPendingFlow(projectRef);
  if (callback.kind === 'error') {
    updateState({ status: 'signed-out', configured: true, error: callback.message });
    return false;
  }

  consumedCodes.add(callback.code);
  const client = authClient ?? getSupabaseClient();
  if (!client) {
    updateState({ status: 'signed-out', configured: true, error: 'Sync configuration is unavailable.' });
    return false;
  }
  authClient = client;
  updateState({ status: 'signing-in', configured: true, error: null });
  try {
    const result = await client.auth.exchangeCodeForSession(
      callback.code,
      callback.flowId ? { flowId: callback.flowId } : undefined,
    );
    if (result.error) throw result.error;
    applySession(result.data.session, true);
    return Boolean(result.data.session?.user?.id);
  } catch (error) {
    updateState({ status: 'signed-out', configured: true, error: sanitizeAuthError(error) });
    throw new Error(sanitizeAuthError(error));
  }
}

async function handleIncomingUrls(urls: string[]) {
  for (const rawUrl of urls) {
    try {
      await handleAuthCallback(rawUrl);
    } catch (error) {
      const message = error instanceof AuthCallbackValidationError ? error.message : sanitizeAuthError(error);
      updateState({ status: state.status === 'signed-in' ? 'signed-in' : 'signed-out', configured: state.configured, error: message });
    }
  }
}

async function installDeepLinkHandlers() {
  if (!isTauriRuntime() || deepLinkUnsubscribe) return;
  deepLinkUnsubscribe = await onOpenUrl(urls => { void handleIncomingUrls(urls); });
  const currentUrls = await getCurrent();
  if (currentUrls?.length) void handleIncomingUrls(currentUrls);
}

export async function initializeAuth(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    const configState = configuredState();
    if (!configState.configured) {
      state = { status: 'signed-out', configured: false, userId: null, email: null, error: null };
      notify();
      return;
    }
    const client = getSupabaseClient();
    if (!client) {
      updateState({ status: 'signed-out', configured: true, error: 'Sync configuration is unavailable.' });
      return;
    }
    authClient = client;
    const subscription = client.auth.onAuthStateChange((_event, session) => {
      applySession(session, true);
    });
    authUnsubscribe = () => subscription.data.subscription.unsubscribe();
    const { data, error } = await client.auth.getSession();
    if (error) {
      updateState({ status: 'signed-out', configured: true, error: sanitizeAuthError(error) });
    } else {
      applySession(data.session, true);
    }
    try {
      await installDeepLinkHandlers();
    } catch (error) {
      updateState({ status: state.status === 'signed-in' ? 'signed-in' : 'signed-out', configured: true, error: sanitizeAuthError(error) });
    }
  })().catch(error => {
    initialization = null;
    updateState({ status: 'signed-out', configured: state.configured, error: sanitizeAuthError(error) });
    throw error;
  });
  return initialization;
}

export async function signOut(): Promise<void> {
  const project = getConfiguredSupabaseProject();
  if (project) clearPendingFlow(project.projectRef);
  const client = authClient ?? getSupabaseClient();
  if (!client) {
    updateState({ status: 'signed-out', userId: null, email: null, error: null });
    return;
  }
  const { error } = await client.auth.signOut();
  if (error) {
    updateState({ error: sanitizeAuthError(error) });
    throw new Error(sanitizeAuthError(error));
  }
  updateState({ status: 'signed-out', userId: null, email: null, error: null });
}

/** Test/teardown hook; it clears listeners but never clears Supabase storage. */
export function disposeAuthListeners(): void {
  authUnsubscribe?.();
  authUnsubscribe = null;
  deepLinkUnsubscribe?.();
  deepLinkUnsubscribe = null;
  initialization = null;
}
