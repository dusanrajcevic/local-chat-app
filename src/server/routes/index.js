const { registerHealthRoutes } = require('./health');
const { registerActiveSessionRoutes } = require('./active-session');
const { registerFolderRoutes } = require('./folders');
const { registerSessionRoutes } = require('./sessions');
const { registerTrashRoutes } = require('./trash');

function registerApiRoutes(app) {
  registerHealthRoutes(app);
  registerActiveSessionRoutes(app);
  registerFolderRoutes(app);
  registerSessionRoutes(app);
  registerTrashRoutes(app);
}

module.exports = { registerApiRoutes };
