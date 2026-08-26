import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSquirrelConfig } from '../hooks/useSquirrel';
import { SquirrelApi, SquirrelApiError, hasHostPermission } from '../utils/squirrelApi';
import { BlogService } from '../utils/blogService';

/** `https://squirrel.vercel.app` -> `https://squirrel.vercel.app/*`. */
function originPatternFor(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

/** Accepts a bare host and normalises to the origin the contract expects. */
function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requestHostPermission(baseUrl: string): Promise<boolean> {
  const pattern = originPatternFor(baseUrl);
  if (!pattern) return Promise.resolve(false);
  try {
    return chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

interface ConnectionReport {
  reachable: boolean;
  auth?: 'ok' | 'rejected' | 'failed';
  pendingCount?: number;
  detail?: string;
}

export const Settings: React.FC = () => {
  const { config, isConfigured, isLoading, save, isSaving, saveError } = useSquirrelConfig();

  const [baseUrl, setBaseUrl] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [revealToken, setRevealToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<ConnectionReport | null>(null);

  // The token is deliberately never seeded back into the field.
  useEffect(() => {
    if (config?.baseUrl) setBaseUrl(config.baseUrl);
  }, [config?.baseUrl]);

  const permissionQuery = useQuery({
    queryKey: ['squirrel', 'permission', config?.baseUrl ?? ''],
    queryFn: () => hasHostPermission(config?.baseUrl ?? ''),
    enabled: Boolean(config?.baseUrl),
    staleTime: 30 * 1000,
    retry: false,
  });

  // Absence is the normal case on any machine but the author's, so this is a
  // plain fact, not a failed query the user should act on.
  const sidecarQuery = useQuery({
    queryKey: ['squirrel', 'sidecar'],
    queryFn: () => BlogService.checkLocalAi(),
    staleTime: 30 * 1000,
    retry: false,
  });

  const hasStoredToken = Boolean(config?.token);
  const permissionGranted = permissionQuery.data === true;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setJustSaved(false);

    const nextUrl = normalizeBaseUrl(baseUrl);
    const nextToken = tokenInput.trim() || config?.token || '';

    if (!nextUrl) {
      setFormError('Enter the service URL, e.g. https://squirrel.vercel.app');
      return;
    }
    if (!nextToken) {
      setFormError('Paste the SQUIRREL_TOKEN from the service environment.');
      return;
    }

    // setConfig asks Chrome for the host permission before it stores anything,
    // and that request is only honoured while the click gesture is still live.
    // It therefore has to be the first await in this handler — anything else
    // awaited first spends the gesture and the prompt never appears.
    try {
      await save({ baseUrl: nextUrl, token: nextToken });
    } catch {
      // saveError carries the reason, including a declined permission.
      return;
    }

    setTokenInput('');
    setRevealToken(false);
    setReport(null);
    setJustSaved(true);
    permissionQuery.refetch();
  };

  const handleGrant = () => {
    // First statement in the handler — see the note in handleSubmit.
    requestHostPermission(config?.baseUrl ?? baseUrl).then(() => permissionQuery.refetch());
  };

  const handleReveal = () => {
    if (!revealToken && config?.token) setTokenInput(config.token);
    setRevealToken((shown) => !shown);
  };

  const runConnectionTest = async () => {
    setTesting(true);
    setReport(null);

    const reachable = await SquirrelApi.health().catch(() => false);
    if (!reachable) {
      setReport({ reachable: false });
      setTesting(false);
      return;
    }

    try {
      const status = await SquirrelApi.getStatus();
      setReport({ reachable: true, auth: 'ok', pendingCount: status.pendingCount });
    } catch (error) {
      // isUnauthorized rather than status 401: Vercel's Deployment Protection
      // answers 401 too, and that is not the user's token being wrong.
      const rejected =
        error instanceof SquirrelApiError && (error.isUnauthorized || error.status === 403);
      if (rejected) {
        setReport({ reachable: true, auth: 'rejected' });
      } else {
        setReport({
          reachable: true,
          auth: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {!isConfigured && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
          <p className="text-sm font-medium text-blue-800">Connect the link service</p>
          <p className="text-xs text-blue-700 mt-1">
            Squirrel buffers links in a small service and writes them into your draft in batches. Point it
            at your deployment and paste its token — the other tabs stay empty until then.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="baseUrl" className="block text-sm font-medium text-gray-700 mb-1">
            Service URL *
          </label>
          <input
            type="text"
            id="baseUrl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="https://squirrel.vercel.app"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="token" className="block text-sm font-medium text-gray-700">
              Token *
            </label>
            {hasStoredToken && (
              <button
                type="button"
                onClick={handleReveal}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                {revealToken ? 'Hide' : 'Reveal saved token'}
              </button>
            )}
          </div>
          <input
            type={revealToken ? 'text' : 'password'}
            id="token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
            placeholder={hasStoredToken ? '•••••••••••••••• (saved — leave blank to keep)' : 'SQUIRREL_TOKEN'}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {formError && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-sm text-red-700">{formError}</p>
          </div>
        )}

        {saveError && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-sm font-medium text-red-800">Could not save settings</p>
            <p className="text-xs text-red-600 mt-1">
              {saveError instanceof Error ? saveError.message : 'Unknown error'}
            </p>
          </div>
        )}

        {justSaved && !saveError && (
          <div className="bg-green-50 border border-green-200 rounded-md p-3">
            <p className="text-sm text-green-800">Settings saved.</p>
          </div>
        )}

        <button
          type="submit"
          disabled={isSaving}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving ? 'Saving...' : 'Save settings'}
        </button>
      </form>

      {isConfigured && !permissionQuery.isLoading && !permissionGranted && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
          <p className="text-sm font-medium text-yellow-800">Access to this service not granted</p>
          <p className="text-xs text-yellow-700 mt-1">
            Chrome needs your permission before the extension may talk to {config?.baseUrl}. Until you grant
            it, every request fails as if the service were down.
          </p>
          <button
            type="button"
            onClick={handleGrant}
            className="mt-2 bg-yellow-600 text-white text-sm py-1.5 px-3 rounded-md hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-yellow-500"
          >
            Grant access
          </button>
        </div>
      )}

      {isConfigured && (
        <div className="border-t pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">Connection</p>
              <p className="text-xs text-gray-500">Checks the saved settings, not the fields above.</p>
            </div>
            <button
              type="button"
              onClick={runConnectionTest}
              disabled={testing}
              className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {testing ? 'Testing...' : 'Test connection'}
            </button>
          </div>

          {report && !report.reachable && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm font-medium text-red-800">Service unreachable</p>
              <p className="text-xs text-red-600 mt-1">
                /api/health did not answer. Check the URL, that the deployment is live, and that access has
                been granted above.
              </p>
            </div>
          )}

          {report?.auth === 'rejected' && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm font-medium text-red-800">Token rejected</p>
              <p className="text-xs text-red-600 mt-1">
                The service answered /api/health, so it is up and reachable — it refused the token. Paste the
                current SQUIRREL_TOKEN and save again.
              </p>
            </div>
          )}

          {report?.auth === 'failed' && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
              <p className="text-sm font-medium text-yellow-800">Service up, /api/status failed</p>
              <p className="text-xs text-yellow-700 mt-1">{report.detail}</p>
            </div>
          )}

          {report?.auth === 'ok' && (
            <div className="bg-green-50 border border-green-200 rounded-md p-3">
              <p className="text-sm font-medium text-green-800">Connected</p>
              <p className="text-xs text-green-700 mt-1">
                Health and token both accepted. {report.pendingCount} link
                {report.pendingCount === 1 ? '' : 's'} buffered.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="border-t pt-4">
        <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
          <div className="flex items-center space-x-2">
            <span
              className={`w-2 h-2 rounded-full ${sidecarQuery.data ? 'bg-green-500' : 'bg-gray-300'}`}
            ></span>
            <p className="text-sm font-medium text-gray-700">
              Local AI helper {sidecarQuery.data ? 'running' : 'not running'}
            </p>
            <span className="text-xs text-gray-400">optional</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {sidecarQuery.data
              ? 'Descriptions and categories are suggested for you as you save.'
              : 'It only runs on the machine you set it up on. Without it you write the description yourself; nothing else changes.'}
          </p>
        </div>
      </div>
    </div>
  );
};
