import { message } from './i18n.js';
import {
  UserError,
  type BackgroundRequest,
  type BackgroundResponse,
} from './model.js';

export async function request(
  payload: BackgroundRequest,
): Promise<BackgroundResponse> {
  const response: BackgroundResponse =
    await chrome.runtime.sendMessage(payload);
  if (!response.ok)
    throw new UserError(response.error ?? message('actionFailed'));
  return response;
}
