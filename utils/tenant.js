export const resolveRestaurantId = (
  req,
  { allowQuery = false, allowBody = false, fallback } = {}
) => {
  if (!req) return null;

  const direct = req.restaurantId || null;

  if (!req.isSystemAdmin) {
    return direct || fallback || null;
  }

  const queryId = allowQuery
    ? (req.query?.restaurantId || req.query?.tenantId || null)
    : null;
  const bodyId = allowBody
    ? (req.body?.restaurantId || req.body?.tenantId || null)
    : null;

  return queryId || bodyId || direct || fallback || null;
};

export const ensureRestaurantId = (req, options = {}) => {
  const id = resolveRestaurantId(req, options);
  if (!id) {
    const error = new Error("Restoran aniqlanmadi");
    error.statusCode = 400;
    throw error;
  }
  return id;
};
