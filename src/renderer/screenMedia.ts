/**
 * Videos shown on LED screens, chosen per session: the file stays on disk and is never copied into the project
 * (a project must stay small and portable). Object URLs are revoked when replaced.
 */
const videos = new Map<string, string>();
let version = 0;

export const screenVideo = (screenId: string): string | undefined => videos.get(screenId);
/** Bumped on every change so the 3D view knows to rebuild the screens. */
export const screenMediaVersion = (): number => version;

export function setScreenVideo(screenId: string, file: File | null): void {
  const old = videos.get(screenId);
  if (old) URL.revokeObjectURL(old);
  if (file) videos.set(screenId, URL.createObjectURL(file));
  else videos.delete(screenId);
  version++;
}
