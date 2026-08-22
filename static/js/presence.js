(() => {
  const HEARTBEAT_MS =
    60 * 1000;

  let heartbeatTimer = null;


  function canSendHeartbeat() {
    /*
      Don't keep someone "online"
      just because Pressboxd is sitting
      hidden in a background tab.
    */
    return (
      document.visibilityState ===
      "visible"
    );
  }


  async function sendHeartbeat() {
    if (!canSendHeartbeat()) {
      return;
    }

    try {
      await fetch(
        "/api/presence",
        {
          method: "POST",

          credentials:
            "same-origin",

          keepalive: true,

          headers: {
            "X-Requested-With":
              "XMLHttpRequest"
          }
        }
      );

    } catch (_err) {
      /*
        Presence is non-critical.

        Internet going out should not
        create console spam or break
        anything else on the page.
      */
    }
  }


  function startHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(
        heartbeatTimer
      );
    }

    sendHeartbeat();

    heartbeatTimer =
      setInterval(
        sendHeartbeat,
        HEARTBEAT_MS
      );
  }


  /*
    Coming back to the tab should
    immediately mark the user active.
  */
  document.addEventListener(
    "visibilitychange",
    () => {
      if (
        document.visibilityState ===
        "visible"
      ) {
        sendHeartbeat();
      }
    }
  );


  window.addEventListener(
    "focus",
    sendHeartbeat
  );


  startHeartbeat();
})();
