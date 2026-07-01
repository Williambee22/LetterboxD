(() => {
  const page = document.querySelector(".tierMakerPage");
  if (!page) return;

  const tierlistId = page.dataset.tierlistId;

  let state;

  try {
    state = JSON.parse(page.dataset.initialData || "{}");
  } catch {
    state = {};
  }

  if (!state.tiers || !Array.isArray(state.tiers)) {
    state = {
      tiers: [
        { id: "tier_s", label: "S", color: "#ff7f7f", items: [] },
        { id: "tier_a", label: "A", color: "#ffbf7f", items: [] },
        { id: "tier_b", label: "B", color: "#ffff7f", items: [] },
        { id: "tier_c", label: "C", color: "#7fff7f", items: [] },
        { id: "tier_d", label: "D", color: "#7fbfff", items: [] },
        { id: "tier_f", label: "F", color: "#bf7fff", items: [] }
      ]
    };
  }

  let showMap = new Map();
  let saveTimer = null;

  const tierBoard = document.getElementById("tierBoard");
  const showPool = document.getElementById("showPool");
  const nameInput = document.getElementById("tierlistName");
  const saveStatus = document.getElementById("saveStatus");

  const corpsFilter = document.getElementById("corpsFilter");
  const yearFilter = document.getElementById("yearFilter");
  const decadeFilter = document.getElementById("decadeFilter");

  const yearFilterWrap = document.getElementById("yearFilterWrap");
  const decadeFilterWrap = document.getElementById("decadeFilterWrap");

  const publicInput = document.getElementById("tierlistPublic");
  const addTierBtn = document.getElementById("addTierBtn");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function updateYearDecadeVisibility() {
    const hasYear = yearFilter && yearFilter.value;
    const hasDecade = decadeFilter && decadeFilter.value;

    if (hasYear) {
      if (decadeFilterWrap) decadeFilterWrap.style.display = "none";
      if (yearFilterWrap) yearFilterWrap.style.display = "";
      return;
    }

    if (hasDecade) {
      if (yearFilterWrap) yearFilterWrap.style.display = "none";
      if (decadeFilterWrap) decadeFilterWrap.style.display = "";
      return;
    }

    if (yearFilterWrap) yearFilterWrap.style.display = "";
    if (decadeFilterWrap) decadeFilterWrap.style.display = "";
  }

  function currentFilters() {
    const yearValue = yearFilter ? yearFilter.value : "";
    const decadeValue = decadeFilter ? decadeFilter.value : "";

    return {
      filter_corps: corpsFilter ? corpsFilter.value : "",
      filter_year: yearValue,
      filter_decade: yearValue ? "" : decadeValue
    };
  }

  function setSaveStatus(text) {
    if (saveStatus) saveStatus.textContent = text;
  }

  function scheduleSave() {
    setSaveStatus("Saving...");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }

  async function saveNow() {
    try {
      const payload = {
        name: nameInput.value,
        ...currentFilters(),
        is_public: publicInput ? publicInput.checked : false,
        data: state
      };

      const res = await fetch(`/tierlists/${tierlistId}/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("Save failed");

      setSaveStatus("Saved");
    } catch (err) {
      console.error(err);
      setSaveStatus("Save failed");
    }
  }

  function allUsedShowIds() {
    const used = new Set();

    for (const tier of state.tiers) {
      for (const id of tier.items || []) {
        used.add(Number(id));
      }
    }

    return used;
  }

  function removeShowFromEverywhere(showId) {
    for (const tier of state.tiers) {
      tier.items = (tier.items || []).filter(id => Number(id) !== Number(showId));
    }
  }

  function createShowCard(show) {
    const card = document.createElement("div");
    card.className = "showCard";
    card.draggable = true;
    card.dataset.showId = show.id;

    if (show.is_default_poster || !show.poster_url) {
      card.classList.add("textOnlyShowCard");
      card.innerHTML = `
        <strong>${escapeHtml(show.name)}</strong>
        <span>${escapeHtml(show.corps || "")} ${escapeHtml(show.year || "")}</span>
      `;
    } else {
      card.innerHTML = `
        <img src="${escapeHtml(show.poster_url)}" alt="">
        <span>${escapeHtml(show.name)}</span>
      `;
    }

    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", String(show.id));
      event.dataTransfer.effectAllowed = "move";
    });

    return card;
  }

  function setupDropZone(zone, onDrop) {
    zone.addEventListener("dragover", event => {
      event.preventDefault();
      zone.classList.add("dragOver");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("dragOver");
    });

    zone.addEventListener("drop", event => {
      event.preventDefault();
      zone.classList.remove("dragOver");

      const showId = event.dataTransfer.getData("text/plain");
      if (!showId) return;

      onDrop(Number(showId));
    });
  }

  function renderTiers() {
    tierBoard.innerHTML = "";

    state.tiers.forEach((tier, index) => {
      if (!Array.isArray(tier.items)) tier.items = [];

      const row = document.createElement("div");
      row.className = "tierRow";

      const label = document.createElement("div");
      label.className = "tierLabel";
      label.style.backgroundColor = tier.color || "#777777";

      label.innerHTML = `
        <input class="tierNameInput" value="${escapeHtml(tier.label || "")}" maxlength="20">
        <input class="tierColorInput" type="color" value="${escapeHtml(tier.color || "#777777")}">
      `;

      const tierNameInput = label.querySelector(".tierNameInput");
      const tierColorInput = label.querySelector(".tierColorInput");

      tierNameInput.addEventListener("input", () => {
        tier.label = tierNameInput.value;
        scheduleSave();
      });

      tierColorInput.addEventListener("input", () => {
        tier.color = tierColorInput.value;
        label.style.backgroundColor = tier.color;
        scheduleSave();
      });

      const zone = document.createElement("div");
      zone.className = "tierItems tierDropZone";
      zone.dataset.tierId = tier.id;

      setupDropZone(zone, showId => {
        removeShowFromEverywhere(showId);
        tier.items.push(Number(showId));
        render();
        scheduleSave();
      });

      for (const showId of tier.items) {
        const show = showMap.get(Number(showId));

        if (show) {
          zone.appendChild(createShowCard(show));
        } else {
          const missing = document.createElement("div");
          missing.className = "showCard textOnlyShowCard";
          missing.innerHTML = `<strong>Saved show #${escapeHtml(showId)}</strong>`;
          zone.appendChild(missing);
        }
      }

      const actions = document.createElement("div");
      actions.className = "tierActions";

      actions.innerHTML = `
        <button type="button" class="smallBtn moveUpBtn">↑</button>
        <button type="button" class="smallBtn moveDownBtn">↓</button>
        <button type="button" class="smallBtn dangerBtn deleteTierBtn">Delete</button>
      `;

      actions.querySelector(".moveUpBtn").addEventListener("click", () => {
        if (index === 0) return;

        const temp = state.tiers[index - 1];
        state.tiers[index - 1] = state.tiers[index];
        state.tiers[index] = temp;

        render();
        scheduleSave();
      });

      actions.querySelector(".moveDownBtn").addEventListener("click", () => {
        if (index >= state.tiers.length - 1) return;

        const temp = state.tiers[index + 1];
        state.tiers[index + 1] = state.tiers[index];
        state.tiers[index] = temp;

        render();
        scheduleSave();
      });

      actions.querySelector(".deleteTierBtn").addEventListener("click", () => {
        if (!confirm("Delete this tier? Shows in it will return to the pool.")) return;

        state.tiers.splice(index, 1);
        render();
        scheduleSave();
      });

      row.appendChild(label);
      row.appendChild(zone);
      row.appendChild(actions);

      tierBoard.appendChild(row);
    });
  }

  function renderPool() {
    showPool.innerHTML = "";

    const used = allUsedShowIds();

    for (const show of showMap.values()) {
      if (!used.has(Number(show.id))) {
        showPool.appendChild(createShowCard(show));
      }
    }

    if (showMap.size === 0) {
      showPool.innerHTML = `<p class="muted">No shows loaded.</p>`;
    }

    setupDropZone(showPool, showId => {
      removeShowFromEverywhere(showId);
      render();
      scheduleSave();
    });
  }

  function render() {
    renderTiers();
    renderPool();
  }

  async function loadShows() {
    updateYearDecadeVisibility();

    const params = new URLSearchParams(currentFilters());

    try {
      const res = await fetch(`/tierlists/${tierlistId}/shows.json?${params.toString()}`);

      if (!res.ok) throw new Error("Could not load shows");

      const json = await res.json();
      const shows = Array.isArray(json.shows) ? json.shows : [];

      showMap = new Map(shows.map(show => [Number(show.id), show]));

      render();
      scheduleSave();
    } catch (err) {
      console.error(err);
      render();
      showPool.innerHTML = `<p class="muted">Could not load shows.</p>`;
    }
  }

  if (addTierBtn) {
    addTierBtn.addEventListener("click", () => {
      state.tiers.push({
        id: `tier_${Date.now()}`,
        label: "New",
        color: "#999999",
        items: []
      });

      render();
      scheduleSave();
    });
  }

  if (nameInput) {
    nameInput.addEventListener("input", scheduleSave);
  }

  if (corpsFilter) {
    corpsFilter.addEventListener("change", loadShows);
  }

  if (yearFilter) {
    yearFilter.addEventListener("change", () => {
      if (yearFilter.value && decadeFilter) {
        decadeFilter.value = "";
      }

      updateYearDecadeVisibility();
      loadShows();
    });
  }

  if (decadeFilter) {
    decadeFilter.addEventListener("change", () => {
      if (decadeFilter.value && yearFilter) {
        yearFilter.value = "";
      }

      updateYearDecadeVisibility();
      loadShows();
    });
  }

  if (publicInput) {
    publicInput.addEventListener("change", scheduleSave);
  }

  render();
  updateYearDecadeVisibility();
  loadShows();
})();
