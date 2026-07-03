const { FOLDER_ID_PATTERN } = require('../config');
const { validateId } = require('../validation');
const { asyncRoute } = require('./helpers');
const { readFolders, createFolder, renameFolder, deleteFolderAndUnpinSessions } = require('../storage/folder-store');

function registerFolderRoutes(app) {
  app.get(
    '/api/folders',
    asyncRoute(async (req, res) => {
      res.json(await readFolders());
    })
  );

  app.post(
    '/api/folders',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createFolder(req.body.name));
    })
  );

  app.patch(
    '/api/folders/:folderId',
    asyncRoute(async (req, res) => {
      const folderId = validateId(req.params.folderId, FOLDER_ID_PATTERN, 'Folder ID');
      res.json(await renameFolder(folderId, req.body.name));
    })
  );

  app.delete(
    '/api/folders/:folderId',
    asyncRoute(async (req, res) => {
      const folderId = validateId(req.params.folderId, FOLDER_ID_PATTERN, 'Folder ID');
      await deleteFolderAndUnpinSessions(folderId);
      res.json({ ok: true });
    })
  );
}

module.exports = { registerFolderRoutes };
