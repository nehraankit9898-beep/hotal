import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";

/** GET /api/notifications — list hotel notifications */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unread") === "true";

    const notifications = await db.notification.findMany({
      where: unreadOnly
        ? { hotelId: auth.user.hotelId, read: false }
        : { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const unreadCount = await db.notification.count({
      where: { hotelId: auth.user.hotelId, read: false },
    });

    return Response.json({
      notifications: notifications.map((n) => ({
        id: n.id,
        level: n.level,
        title: n.title,
        message: n.message,
        read: n.read,
        metadata: n.metadata,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
    });
  } catch (err) {
    return serverError(err, "Notifications could not be loaded.");
  }
}

/** PUT /api/notifications?id=<id> — mark a single notification as read */
export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id)
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "ID is required." } },
        { status: 400 },
      );

    const updated = await db.notification.updateMany({
      where: { id, hotelId: auth.user.hotelId },
      data: { read: true },
    });

    return Response.json({ updated: updated.count });
  } catch (err) {
    return serverError(err, "Could not mark notification as read.");
  }
}

/** DELETE /api/notifications — mark all as read */
export async function DELETE(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    const result = await db.notification.updateMany({
      where: { hotelId: auth.user.hotelId, read: false },
      data: { read: true },
    });

    return Response.json({ updated: result.count });
  } catch (err) {
    return serverError(err, "Could not mark all notifications as read.");
  }
}
