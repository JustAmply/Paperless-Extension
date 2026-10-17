import {
  UserError,
  type BackgroundRequest,
  type BackgroundResponse,
} from './model.js';

export async function request(
  message: BackgroundRequest,
): Promise<BackgroundResponse> {
  const response: BackgroundResponse =
    await chrome.runtime.sendMessage(message);
  if (!response.ok)
    throw new UserError(
      response.error ?? 'Die Aktion konnte nicht abgeschlossen werden.',
    );
  return response;
}
