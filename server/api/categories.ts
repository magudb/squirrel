import { CATEGORIES } from './_lib/categories.js';
import { methods, withApiAuth } from './_lib/http.js';

/**
 * Served from the server rather than bundled into the extension so a category
 * added here does not require a Web Store release to become selectable.
 */
export default withApiAuth(
  methods({
    GET: (_req, res) => {
      res.status(200).json(CATEGORIES);
    },
  }),
);
