export function formatPayload(payloadJSON: string): string {
  try {
    const obj = JSON.parse(payloadJSON) as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  } catch {
    return payloadJSON;
  }
}

export function statusTagClass(status: string): string {
  switch (status) {
    case "acked":
      return "tag tag-accent";
    case "failed":
      return "tag tag-outline";
    case "sent":
      return "tag tag-accent-2";
    default:
      return "tag tag-neutral";
  }
}
