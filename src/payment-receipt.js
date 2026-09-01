export async function claimPaymentReceipt(storage, chargeId, now = Date.now()) {
  const key = `payment:${chargeId}`;
  return storage.transaction(async txn => {
    const current = await txn.get(key);
    if (!current) return { claimed: false, reason: "missing", record: null };
    if (current.status === "refunded") return { claimed: false, reason: "refunded", record: current };
    if (current.receiptSent) return { claimed: false, reason: "sent", record: current };
    if (current.receiptClaimed) return { claimed: false, reason: "claimed", record: current };

    const claimed = {
      ...current,
      receiptClaimed: true,
      receiptClaimedAt: now,
      receiptState: "sending"
    };
    await txn.put(key, claimed);
    return { claimed: true, reason: "claimed", record: claimed };
  });
}

export async function completePaymentReceipt(storage, record, now = Date.now()) {
  const updated = {
    ...record,
    receiptSent: true,
    receiptSentAt: now,
    receiptState: "sent"
  };
  await storage.put(`payment:${record.chargeId}`, updated);
  return updated;
}

export async function failPaymentReceipt(storage, record, error, now = Date.now()) {
  const updated = {
    ...record,
    receiptState: "failed",
    receiptFailedAt: now,
    receiptError: String(error?.message || error || "unknown")
  };
  await storage.put(`payment:${record.chargeId}`, updated);
  return updated;
}
