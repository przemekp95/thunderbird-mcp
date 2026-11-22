// Observe native fetch completion for a single configured TLS IMAP inbox.
export function createMailAccountRefresher({ MailServices, Services, Ci, Components, ChromeUtils }, canAccess) {
  const attempts = new Map();
  const unavailable = { success: false, error: "Account or native inbox refresh is unavailable" };

  return function refreshMailAccount(args) {
    if (!args || !/^account[1-9][0-9]*$/.test(args.accountId) ||
        !["start", "status"].includes(args.action) ||
        (args.action === "start" && args.confirmRefresh !== true)) {
      return { success: false, error: "Invalid refresh request or missing confirmation" };
    }
    try {
      if (!canAccess(args.accountId)) return unavailable;
      const account = Array.from(MailServices.accounts.accounts).find(entry => entry.key === args.accountId);
      const server = account?.incomingServer;
      if (!server || server.type !== "imap" ||
          ![Ci.nsMsgSocketType.SSL, Ci.nsMsgSocketType.alwaysSTARTTLS].includes(server.socketType)) {
        return unavailable;
      }
      const previous = attempts.get(account.key);
      const current = previous?.server === server ? previous : null;
      const describe = attempt => ({
        success: true,
        status: attempt?.status ?? "notStarted",
        stage: attempt?.stage ?? null,
        nativeStatus: attempt?.nativeStatus ?? null,
        refreshVerified: attempt?.status === "succeeded",
        smtpVerified: false,
      });
      if (args.action === "status" || current?.status === "started") return describe(current);

      const inbox = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      if (!inbox || !win?.msgWindow) return unavailable;

      const attempt = { server, stage: "login", status: "started" };
      attempts.set(account.key, attempt);
      function listener(stage) {
        return {
          QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
          OnStartRunningUrl() {},
          OnStopRunningUrl(_url, status) {
            if (attempts.get(account.key) !== attempt || attempt.status !== "started" || attempt.stage !== stage) return;
            attempt.nativeStatus = Number.isInteger(status) ? status : null;
            if (!Components.isSuccessCode(status)) {
              attempt.status = "failed";
            } else if (stage === "fetch") {
              attempt.status = "succeeded";
            } else {
              attempt.stage = "fetch";
              try {
                inbox.QueryInterface(Ci.nsIMsgImapMailFolder).updateFolderWithListener(win.msgWindow, listener("fetch"));
              } catch {
                attempt.status = "failed";
                attempt.nativeStatus = null;
              }
            }
          },
        };
      }

      try {
        server.verifyLogon(listener("login"), win.msgWindow);
      } catch {
        attempt.status = "failed";
        attempt.nativeStatus = null;
      }
      return describe(attempt);
    } catch {
      return unavailable;
    }
  };
}
