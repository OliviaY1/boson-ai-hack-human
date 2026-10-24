/**
 * Read a JSON reply from the backend (repo root `npm run dev`, reached through
 * the dashboard's /api proxy). An empty or non-JSON reply means the backend did
 * not answer — it is not running, crashed, or was restarting — so say that
 * instead of a bare "Unexpected end of JSON input".
 */
export async function readBackendJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(
      `The backend sent no reply (HTTP ${res.status}). Check that \`npm run dev\` is running at the repo root and look at its terminal for errors; if it just restarted, try again.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The backend sent a reply that is not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}
