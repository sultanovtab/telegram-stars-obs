const DEFAULT_RECENT_LIMIT = 500;

export function telegramUpdateFingerprint(update = {}) {
  const callbackId = update.callback_query?.id;
  if (callbackId) return `callback:${callbackId}`;

  const chatId = update.message?.chat?.id;
  const messageId = update.message?.message_id;
  if (chatId !== undefined && chatId !== null && messageId !== undefined && messageId !== null) {
    return `message:${chatId}:${messageId}`;
  }

  if (update.update_id !== undefined && update.update_id !== null) {
    return `update:${update.update_id}`;
  }

  return "";
}

export function isPaymentCriticalUpdate(update = {}) {
  return Boolean(
    update.pre_checkout_query ||
    update.message?.successful_payment ||
    update.message?.refunded_payment
  );
}

export async function reserveTelegramUpdate(storage, update, recentLimit = DEFAULT_RECENT_LIMIT) {
  const fingerprint = telegramUpdateFingerprint(update);
  const updateId = update?.update_id;
  const updateKey = updateId !== undefined && updateId !== null ? `update:${updateId}` : "";
  if (!fingerprint && !updateKey) return true;

  return storage.transaction(async txn => {
    const [recentRaw, legacyRaw] = await Promise.all([
      txn.get("processedUpdatesV2"),
      txn.get("processedUpdates")
    ]);

    const recent = Array.isArray(recentRaw) ? recentRaw.slice() : [];
    const legacy = Array.isArray(legacyRaw) ? legacyRaw : [];

    if (
      (fingerprint && recent.includes(fingerprint)) ||
      (updateKey && recent.includes(updateKey)) ||
      (updateId !== undefined && updateId !== null && legacy.includes(updateId))
    ) {
      return false;
    }

    if (fingerprint) recent.push(fingerprint);
    if (updateKey && updateKey !== fingerprint) recent.push(updateKey);

    const limit = Math.max(50, Number(recentLimit) || DEFAULT_RECENT_LIMIT);
    if (recent.length > limit) recent.splice(0, recent.length - limit);
    await txn.put("processedUpdatesV2", recent);
    return true;
  });
}
