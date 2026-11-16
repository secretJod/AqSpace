/* repository.js - the one object the rest of the app uses to read and write data.

   What:  createRepo(db) glues the smaller repo files together into a single `repo` object.
   How it fits: app.js creates it once; routes and services receive it as a parameter.
   Files: users-repo.js, playlists-repo.js, progress-repo.js, sync-import-repo.js
          (and playlist-helpers.js, shared by the playlist and import code).
   Read next: db/playlists-repo.js */
import { createPlaylistHelpers } from "./playlist-helpers.js";
import { createUsersRepo } from "./users-repo.js";
import { createPlaylistsRepo } from "./playlists-repo.js";
import { createProgressRepo } from "./progress-repo.js";
import { createSyncImportRepo } from "./sync-import-repo.js";

/**
 * Builds the repository: every data function the routes and services use, in one object.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {object} user, session, playlist, progress and import functions (see the files listed above)
 */
export function createRepo(db) {
  const helpers = createPlaylistHelpers(db);
  const users = createUsersRepo(db);
  const playlists = createPlaylistsRepo(db, helpers);
  const progress = createProgressRepo(db, helpers);
  const syncImport = createSyncImportRepo(db, helpers, {
    listPlaylists: playlists.listPlaylists,
    allProgress: progress.allProgress
  });

  return {
    // users and sign-in sessions
    ...users,
    ensureVideo: helpers.ensureVideo,
    // playlists and their videos
    ...playlists,
    // watch progress
    ...progress,
    // browser data import
    importState: syncImport.importState
  };
}
