(function () {
  "use strict";

  const STORAGE_KEY = "daylight-planner-v1";
  const RECOVERY_KEY = `${STORAGE_KEY}-recovery`;
  const state = {
    details: { name: "A lovely day out", date: "", startingPoint: "", diameter: 5, startingCoordinates: null },
    activities: []
  };
  let undoState = null;
  let map = null;
  let mapLayer = null;
  let mapLibraryPromise = null;

  const $ = (selector) => document.querySelector(selector);
  const form = $("#activity-form");
  const list = $("#itinerary-list");
  const template = $("#activity-template");
  let optionsMap = null;
  let optionLayer = null;
  let customExploreCenter = null;
  let pendingOptionCoordinates = null;
  let storageCanSave = true;
  let persistedRevision = 0;
  let lastSavedRaw = null;
  let pendingExternalRaw = null;
  let storageConflict = false;
  let damagedStatePending = false;
  const failedGeocodes = new Map();
  const FAILED_GEOCODE_TTL_MS = 60 * 60 * 1000;

  const exploreCategories = {
    food: {
      filter: '["amenity"~"^(restaurant|cafe|fast_food|pub|bar|food_court)$"]',
      itineraryCategory: "Food & drink"
    },
    attractions: {
      filter: '["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium)$"]',
      itineraryCategory: "Attraction"
    },
    outdoors: {
      filter: '["leisure"~"^(park|garden|nature_reserve|playground)$"]',
      itineraryCategory: "Outdoors"
    },
    shopping: {
      filter: '["shop"]',
      itineraryCategory: "Shopping"
    }
  };

  const exploreParties = {
    solo: { label: "1 person", type: "solo" },
    couple: { label: "couple", type: "couple" },
    "small-group": { label: "small group", type: "small-group" },
    family: { label: "family", type: "family" },
    older: { label: "older visitor or couple", type: "older" },
    "large-group": { label: "large group", type: "large-group" },
    "celebration-group": { label: "celebration group", type: "celebration-group" }
  };

  const exploreDurations = {
    nearby: { label: "closer-option ordering" },
    wider: { label: "wider-area ordering" }
  };

  function minutesFromTime(time) {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function activityStartMinutes(activity) {
    return (activity.dayOffset || 0) * 1440 + minutesFromTime(activity.startTime);
  }

  function formatTime(minutes, showDayOffset = false) {
    const normalized = ((minutes % 1440) + 1440) % 1440;
    const hours = Math.floor(normalized / 60);
    const mins = normalized % 60;
    const time = new Date(2000, 0, 1, hours, mins).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    const dayOffset = Math.floor(minutes / 1440);
    return showDayOffset && dayOffset > 0 ? `${time} (+${dayOffset} day${dayOffset === 1 ? "" : "s"})` : time;
  }

  function formatDuration(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
  }

  function currency(value) {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
  }

  function generateId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function distanceMetres(from, to) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const earthRadius = 6371000;
    const dLat = radians(to.lat - from.lat);
    const dLon = radians(to.lon - from.lon);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLon / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function readableKind(tags) {
    const value = tags.amenity || tags.tourism || tags.leisure || tags.shop || "place";
    return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function safeHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value.trim().match(/^https?:\/\//i) ? value.trim() : `https://${value.trim()}`);
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch (error) {
      return null;
    }
  }

  function optionFitScore(option, profile, duration, radius) {
    const type = option.tags.amenity || option.tags.tourism || option.tags.leisure || option.tags.shop || "";
    const partyType = exploreParties[profile].type;
    let score = 0;
    if (partyType === "family") {
      if (["park", "garden", "playground", "zoo", "aquarium", "theme_park", "museum", "cafe", "food_court"].includes(type)) score += 4;
      if (["pub", "bar"].includes(type)) score -= 5;
    }
    if (partyType === "older") {
      if (option.tags.wheelchair === "yes") score += 4;
      if (option.tags.toilets === "yes") score += 2;
      if (["garden", "museum", "gallery", "cafe", "restaurant"].includes(type)) score += 2;
      if (["bar", "fast_food"].includes(type)) score -= 2;
    }
    if (partyType === "celebration-group") {
      if (["pub", "bar", "restaurant", "food_court", "theme_park"].includes(type)) score += 4;
      if (option.tags.reservation === "yes" || option.tags.outdoor_seating === "yes") score += 1;
    }
    if (partyType === "large-group") {
      if (["attraction", "museum", "restaurant", "food_court", "park"].includes(type)) score += 3;
      if (option.tags.reservation === "yes" || option.tags.toilets === "yes") score += 1;
    }
    if (partyType === "small-group" && ["restaurant", "cafe", "museum", "attraction", "park"].includes(type)) score += 2;
    if (partyType === "couple" && ["restaurant", "cafe", "gallery", "viewpoint", "garden"].includes(type)) score += 3;
    if (partyType === "solo" && ["museum", "gallery", "viewpoint", "cafe", "park"].includes(type)) score += 2;
    score -= option.distance / (duration === "wider" ? 4000 : 1800);
    if (option.distance > radius) score += duration === "wider" ? 0.5 : -1;
    return score;
  }

  function optionFitText(option, profile, duration) {
    const party = exploreParties[profile];
    const type = option.tags.amenity || option.tags.tourism || option.tags.leisure || option.tags.shop || "";
    const reasons = [];
    if (party.type === "family" && ["park", "garden", "playground", "zoo", "aquarium", "theme_park"].includes(type)) reasons.push("child-oriented place type");
    if (party.type === "older" && option.tags.wheelchair === "yes") reasons.push("wheelchair access tagged");
    if (["large-group", "celebration-group"].includes(party.type) && option.tags.reservation === "yes") reasons.push("reservations tagged");
    if (option.tags.toilets === "yes") reasons.push("toilets tagged");
    if (!reasons.length) reasons.push("ordered by distance and available map tags");
    return `${party.label} · ${exploreDurations[duration].label} · ${reasons.join(" · ")}`;
  }

  function formatMiles(metres) {
    const miles = metres / 1609.344;
    const rounded = miles.toFixed(1);
    return `${rounded} ${rounded === "1.0" ? "mile" : "miles"}`;
  }

  function setExploreStatus(message, isError = false) {
    const status = $("#explore-status");
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  function setExploreBusy(busy) {
    const controls = document.querySelectorAll("#explore-form input, #explore-form select, #explore-form button");
    controls.forEach((control) => { control.disabled = busy; });
    const button = $('#explore-form button[type="submit"]');
    button.textContent = busy ? "Finding…" : "Find places";
  }

  function lockPlannerInputs() {
    const controls = [...document.querySelectorAll(
      ".plan-details input, #activity-form input, #activity-form select, #activity-form textarea, #activity-form button, " +
      "#itinerary-list button, #sample-plan, #clear-plan, #rank-order, #undo-action"
    )];
    const previous = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    return () => controls.forEach((control, index) => { control.disabled = previous[index]; });
  }

  async function geocodeArea(query) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.search = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("The area search service is unavailable right now.");
    const matches = await response.json();
    if (!matches.length) throw new Error("We could not find that area. Try a town, postcode, or more specific place name.");
    return { lat: Number(matches[0].lat), lon: Number(matches[0].lon), label: matches[0].display_name };
  }

  async function fetchNearbyOptions(center, radius, category, profile, duration) {
    const outerRadius = Math.round(radius * 1.22);
    const filter = exploreCategories[category].filter;
    const around = `(around:${outerRadius},${center.lat},${center.lon})`;
    const query = `[out:json][timeout:20];(` +
      `node${filter}["name"]${around};way${filter}["name"]${around};` +
      `);out center 200;`;
    const nodeFallback = `[out:json][timeout:20];node${filter}["name"]${around};out body 200;`;
    const request = (data) => fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ data })
    });
    let response = await request(query);
    if (!response.ok) response = await request(nodeFallback);
    if (!response.ok) throw new Error("The nearby-place service is busy. Please try again in a moment.");
    const data = await response.json();
    const seen = new Set();
    const options = [];

    data.elements.forEach((element) => {
      const tags = element.tags || {};
      const lat = Number(element.lat ?? element.center?.lat);
      const lon = Number(element.lon ?? element.center?.lon);
      const name = typeof tags.name === "string" ? tags.name.trim() : "";
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const key = `${name.toLowerCase()}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const distance = distanceMetres(center, { lat, lon });
      if (distance > outerRadius) return;
      options.push({ id: `${element.type}-${element.id}`, name, lat, lon, distance, tags });
    });

    options.forEach((option) => { option.fitScore = optionFitScore(option, profile, duration, radius); });
    options.sort((a, b) => b.fitScore - a.fitScore || a.distance - b.distance);
    const inside = options.filter((option) => option.distance <= radius).slice(0, 20);
    const fringe = options.filter((option) => option.distance > radius).slice(0, 10);
    return [...inside, ...fringe].sort((a, b) => b.fitScore - a.fitScore || a.distance - b.distance);
  }

  function ensureOptionsMap(center) {
    if (!window.L) throw new Error("The map could not load. Check your connection and refresh the page.");
    if (!optionsMap) {
      optionsMap = window.L.map("options-map");
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(optionsMap);
      optionLayer = window.L.layerGroup().addTo(optionsMap);
    }
    optionsMap.setView([center.lat, center.lon], 13);
  }

  function addOptionToForm(option, category, areaLabel, profile, duration) {
    resetForm();
    $("#activity-name").value = option.name;
    $("#activity-location").value = option.name;
    $("#category").value = exploreCategories[category].itineraryCategory;
    const openingHours = typeof option.tags.opening_hours === "string" ? option.tags.opening_hours.trim() : "";
    const website = safeHttpUrl(option.tags.website || option.tags["contact:website"]);
    const noteParts = [
      `Suggested near ${areaLabel} for ${exploreParties[profile].label}, ${exploreDurations[duration].label} · ${formatMiles(option.distance)} from the centre.`,
      openingHours ? `OSM hours: ${openingHours} (verify before visiting).` : "",
      website ? `Venue: ${website}` : ""
    ].filter(Boolean);
    $("#notes").value = noteParts.join(" ").slice(0, 240);
    pendingOptionCoordinates = { lat: option.lat, lon: option.lon, query: option.name };
    $("#activity-name").focus();
    $(".activity-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderNearbyOptions(center, radius, category, profile, duration, options) {
    $("#explore-results").classList.remove("hidden");
    ensureOptionsMap(center);
    optionLayer.clearLayers();
    const outerRadius = radius * 1.22;
    window.L.circle([center.lat, center.lon], {
      radius: outerRadius, color: "#e97945", fillColor: "#e97945", fillOpacity: 0.04, dashArray: "7 7", weight: 2
    }).addTo(optionLayer);
    window.L.circle([center.lat, center.lon], {
      radius, color: "#315c49", fillColor: "#315c49", fillOpacity: 0.06, weight: 2
    }).addTo(optionLayer);
    window.L.circleMarker([center.lat, center.lon], {
      radius: 6, color: "#24322b", fillColor: "#dbea90", fillOpacity: 1, weight: 2
    }).bindPopup("Search centre").addTo(optionLayer);

    const optionList = $("#option-list");
    optionList.replaceChildren();
    options.forEach((option) => {
      const fringe = option.distance > radius;
      const marker = window.L.circleMarker([option.lat, option.lon], {
        radius: 6,
        color: fringe ? "#a44335" : "#234437",
        fillColor: fringe ? "#e97945" : "#315c49",
        fillOpacity: 0.9,
        weight: 2
      });
      const popup = document.createElement("strong");
      popup.textContent = option.name;
      marker.bindPopup(popup).addTo(optionLayer);

      const item = document.createElement("li");
      item.className = `option-card${fringe ? " fringe" : ""}`;
      item.tabIndex = 0;
      const titleRow = document.createElement("div");
      titleRow.className = "option-title-row";
      const name = document.createElement("strong");
      name.textContent = option.name;
      const distance = document.createElement("span");
      distance.className = "option-distance";
      distance.textContent = fringe
        ? `${formatMiles(option.distance)} · just outside`
        : formatMiles(option.distance);
      titleRow.append(name, distance);
      const kind = document.createElement("p");
      kind.className = "option-kind";
      kind.textContent = readableKind(option.tags);
      const fit = document.createElement("p");
      fit.className = "option-fit";
      fit.textContent = optionFitText(option, profile, duration);
      const details = document.createElement("p");
      details.className = "option-details";
      const openingHours = typeof option.tags.opening_hours === "string" ? option.tags.opening_hours.trim() : "";
      if (openingHours) {
        const hours = document.createElement("span");
        hours.textContent = `OSM hours: ${openingHours} · verify`;
        details.append(hours);
      }
      const phone = option.tags.phone || option.tags["contact:phone"];
      if (typeof phone === "string" && phone.trim()) {
        const phoneText = document.createElement("span");
        phoneText.textContent = `Phone: ${phone.trim()}`;
        details.append(phoneText);
      }
      const websiteUrl = safeHttpUrl(option.tags.website || option.tags["contact:website"]);
      if (websiteUrl) {
        const website = document.createElement("a");
        website.href = websiteUrl;
        website.target = "_blank";
        website.rel = "noopener";
        website.textContent = "Venue website";
        website.addEventListener("click", (event) => event.stopPropagation());
        details.append(website);
      }
      const osmSource = document.createElement("a");
      osmSource.href = `https://www.openstreetmap.org/${option.id.replace("-", "/")}`;
      osmSource.target = "_blank";
      osmSource.rel = "noopener";
      osmSource.textContent = "OSM source";
      osmSource.addEventListener("click", (event) => event.stopPropagation());
      details.append(osmSource);
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "add-option";
      addButton.textContent = "Add to itinerary form";
      addButton.addEventListener("click", (event) => {
        event.stopPropagation();
        addOptionToForm(option, category, center.label, profile, duration);
      });
      const showMarker = () => {
        optionsMap.setView([option.lat, option.lon], Math.max(optionsMap.getZoom(), 15));
        marker.openPopup();
      };
      item.addEventListener("click", showMarker);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showMarker();
        }
      });
      item.append(titleRow, kind, fit, details, addButton);
      optionList.append(item);
    });

    optionsMap.fitBounds(window.L.latLng(center.lat, center.lon).toBounds(outerRadius * 2));
    setTimeout(() => optionsMap.invalidateSize(), 0);
    const fringeCount = options.filter((option) => option.distance > radius).length;
    setExploreStatus(`${options.length} places for ${exploreParties[profile].label} near ${center.label}${fringeCount ? `, including ${fringeCount} within the extra 22%` : ""}. These are OSM places, not live events; verify opening hours and current listings.`);
  }

  async function searchNearby(center) {
    const allowedRadii = new Set([804, 1609, 3219]);
    const radius = Number($("#explore-radius").value);
    if (!allowedRadii.has(radius)) {
      $("#explore-radius").value = "1609";
      setExploreStatus("Choose one of the supported search radii before searching.", true);
      setExploreBusy(false);
      return;
    }
    const category = $("#explore-category").value;
    const profile = $("#explore-party").value;
    const duration = $("#explore-duration").value;
    setExploreBusy(true);
    setExploreStatus(`Searching up to ${formatMiles(radius * 1.22)} from ${center.label} for ${exploreParties[profile].label}…`);
    try {
      const [options] = await Promise.all([
        fetchNearbyOptions(center, radius, category, profile, duration),
        loadMapLibrary()
      ]);
      if (!options.length) {
        $("#explore-results").classList.add("hidden");
        setExploreStatus("No named places were found in this area. Try a larger radius or another category.");
      } else {
        renderNearbyOptions(center, radius, category, profile, duration, options);
      }
    } catch (error) {
      setExploreStatus(error.message || "Nearby places could not be loaded.", true);
    } finally {
      setExploreBusy(false);
    }
  }

  function sortedActivities() {
    return [...state.activities].sort((a, b) => activityStartMinutes(a) - activityStartMinutes(b));
  }

  function displayedActivities() {
    const activities = sortedActivities();
    if (state.details.ranking === "cost-asc") return activities.sort((a, b) => a.cost - b.cost);
    if (state.details.ranking === "cost-desc") return activities.sort((a, b) => b.cost - a.cost);
    return activities;
  }

  function locationFor(activity) {
    return activity.location || activity.name;
  }

  function modeLabel(mode) {
    return ({ transit: "public transport", driving: "car", bicycling: "bicycle", walking: "walking" })[mode] || "public transport";
  }

  function directionsUrl(origin, destination, mode, waypoints = []) {
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    if (origin) url.searchParams.set("origin", origin);
    if (destination) url.searchParams.set("destination", destination);
    if (mode) url.searchParams.set("travelmode", mode);
    if (waypoints.length) url.searchParams.set("waypoints", waypoints.join("|"));
    return url.toString();
  }

  function detectConflicts(activities) {
    const conflicts = new Map();
    activities.forEach((activity, index) => {
      if (index === 0) return;
      const blocker = activities.slice(0, index).reduce((latest, candidate) => {
        const candidateEnd = activityStartMinutes(candidate) + candidate.duration;
        return !latest || candidateEnd > latest.end ? { activity: candidate, end: candidateEnd } : latest;
      }, null);
      const requiredStart = blocker.end + activity.travelTime;
      const actualStart = activityStartMinutes(activity);
      if (actualStart < requiredStart) {
        const shortage = requiredStart - actualStart;
        conflicts.set(activity.id, `Needs ${formatDuration(shortage)} more between this stop and ${blocker.activity.name}.`);
      }
    });
    return conflicts;
  }

  function normalizedActivity(activity) {
    if (!activity || typeof activity !== "object") return null;
    const startTime = typeof activity.startTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(activity.startTime)
      ? activity.startTime
      : null;
    const name = typeof activity.name === "string" ? activity.name.trim().slice(0, 80) : "";
    const duration = Number(activity.duration);
    const travelTime = Number(activity.travelTime);
    const cost = Number(activity.cost);
    const dayOffset = Number(activity.dayOffset);
    if (!startTime || !name || !Number.isFinite(duration) || duration <= 0 || duration > 1440) return null;
    return {
      id: typeof activity.id === "string" && activity.id ? activity.id : generateId(),
      name,
      startTime,
      dayOffset: Number.isInteger(dayOffset) && dayOffset === 1 ? 1 : 0,
      duration,
      travelTime: Number.isFinite(travelTime) ? Math.min(1440, Math.max(0, travelTime)) : 0,
      cost: Number.isFinite(cost) ? Math.min(100000, Math.max(0, cost)) : 0,
      category: typeof activity.category === "string" ? activity.category.slice(0, 40) : "Other",
      notes: typeof activity.notes === "string" ? activity.notes.slice(0, 240) : "",
      location: typeof activity.location === "string" ? activity.location.slice(0, 120) : "",
      travelMode: ["transit", "driving", "bicycling", "walking"].includes(activity.travelMode) ? activity.travelMode : "transit",
      coordinates: normalizedCoordinates(activity.coordinates, typeof activity.location === "string" && activity.location ? activity.location.slice(0, 120) : name)
    };
  }

  function normalizedCoordinates(value, expectedQuery = "") {
    if (!value || typeof value !== "object") return null;
    const lat = Number(value.lat);
    const lon = Number(value.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const query = typeof value.query === "string" ? value.query.slice(0, 120) : "";
    if (expectedQuery && query !== expectedQuery) return null;
    return { lat, lon, query };
  }

  function save() {
    if (!storageCanSave || storageConflict) return;
    try {
      const currentRaw = localStorage.getItem(STORAGE_KEY);
      if (currentRaw !== lastSavedRaw) {
        showStorageConflict(currentRaw);
        return;
      }
      const nextRevision = persistedRevision + 1;
      const raw = JSON.stringify({ ...state, _revision: nextRevision });
      localStorage.setItem(STORAGE_KEY, raw);
      persistedRevision = nextRevision;
      lastSavedRaw = raw;
    } catch (error) {
      showNotice("This browser could not save the plan, but you can continue using it for now.");
    }
  }

  function showStorageConflict(raw) {
    pendingExternalRaw = raw;
    storageConflict = true;
    $("#storage-conflict").classList.remove("hidden");
  }

  function clearStorageConflict() {
    pendingExternalRaw = null;
    storageConflict = false;
    $("#storage-conflict").classList.add("hidden");
  }

  function preserveDamagedStorage(raw) {
    storageCanSave = false;
    damagedStatePending = true;
    try {
      localStorage.setItem(RECOVERY_KEY, raw);
      return "Some saved plan data was damaged. Automatic saving is paused; use Recovery copies or explicitly choose Use repaired plan.";
    } catch (error) {
      return "Some saved plan data was damaged and could not be loaded. This browser could not create a recovery copy, so the original will not be overwritten.";
    }
  }

  function applySavedState(saved) {
    state.details = {
      name: typeof saved.details.name === "string" ? saved.details.name.slice(0, 60) : state.details.name,
      date: typeof saved.details.date === "string" ? saved.details.date : "",
      startingPoint: typeof saved.details.startingPoint === "string" ? saved.details.startingPoint.slice(0, 80) : "",
      diameter: Number.isFinite(Number(saved.details.diameter)) ? Math.min(100, Math.max(1, Number(saved.details.diameter))) : 5,
      ranking: ["time", "cost-asc", "cost-desc"].includes(saved.details.ranking) ? saved.details.ranking : "time",
      startingCoordinates: normalizedCoordinates(saved.details.startingCoordinates, typeof saved.details.startingPoint === "string" ? saved.details.startingPoint.slice(0, 80) : "")
    };
    const normalizedActivities = saved.activities.map(normalizedActivity);
    state.activities = normalizedActivities.filter(Boolean);
    return state.activities.length === saved.activities.length;
  }

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return "";
      lastSavedRaw = raw;
      const saved = JSON.parse(raw);
      if (saved && Array.isArray(saved.activities) && saved.details) {
        persistedRevision = Number.isInteger(saved._revision) && saved._revision >= 0 ? saved._revision : 0;
        if (!applySavedState(saved)) return preserveDamagedStorage(raw);
        return "";
      }
      return preserveDamagedStorage(raw);
    } catch (error) {
      if (typeof raw === "string") return preserveDamagedStorage(raw);
      storageCanSave = false;
      return "Browser storage is unavailable. The plan will work for this session but cannot be saved.";
    }
  }

  function showNotice(message) {
    const notice = $("#notice");
    notice.textContent = message;
    notice.classList.remove("hidden");
  }

  function planSnapshot() {
    return {
      details: { ...state.details },
      activities: state.activities.map((activity) => ({ ...activity }))
    };
  }

  function clearUndo() {
    undoState = null;
    $("#undo-notice").classList.add("hidden");
  }

  function rememberUndo(message) {
    undoState = planSnapshot();
    $("#undo-message").textContent = message;
    $("#undo-notice").classList.remove("hidden");
  }

  function syncDetailInputs() {
    $("#plan-name").value = state.details.name;
    $("#plan-date").value = state.details.date;
    $("#starting-point").value = state.details.startingPoint;
    $("#trip-diameter").value = state.details.diameter || 5;
    $("#rank-order").value = state.details.ranking || "time";
    if (!customExploreCenter) $("#explore-area").value = state.details.startingPoint;
  }

  function setText(container, field, value) {
    container.querySelector(`[data-field="${field}"]`).textContent = value;
  }

  function render() {
    const chronological = sortedActivities();
    const activities = displayedActivities();
    const conflicts = detectConflicts(chronological);
    const costOrder = [...chronological].sort((a, b) => a.cost - b.cost || activityStartMinutes(a) - activityStartMinutes(b));
    const costBands = [...new Set(costOrder.map((activity) => activity.cost))];
    list.replaceChildren();

    activities.forEach((activity) => {
      const item = template.content.firstElementChild.cloneNode(true);
      item.dataset.id = activity.id;
      const start = activityStartMinutes(activity);
      setText(item, "start", formatTime(start, true));
      setText(item, "end", formatTime(start + activity.duration, true));
      setText(item, "category", activity.category);
      setText(item, "name", activity.name);
      setText(item, "duration", formatDuration(activity.duration));
      setText(item, "cost", activity.cost > 0 ? currency(activity.cost) : "Free");
      setText(item, "cost-rank", `Cost rank #${costBands.indexOf(activity.cost) + 1}`);
      setText(item, "travel", `${activity.travelTime ? `${formatDuration(activity.travelTime)} travel before` : "No travel time added"} · ${modeLabel(activity.travelMode)}`);

      if (activity.location) {
        setText(item, "location", activity.location);
        item.querySelector('[data-field="location"]').classList.remove("hidden");
      }
      const chronologicalIndex = chronological.findIndex((entry) => entry.id === activity.id);
      const previous = chronologicalIndex > 0 ? locationFor(chronological[chronologicalIndex - 1]) : state.details.startingPoint;
      item.querySelector('[data-field="directions"]').href = directionsUrl(previous, locationFor(activity), activity.travelMode);

      if (activity.notes) {
        setText(item, "notes", activity.notes);
        item.querySelector('[data-field="notes"]').classList.remove("hidden");
      }
      if (conflicts.has(activity.id)) {
        setText(item, "conflict", conflicts.get(activity.id));
        item.querySelector('[data-field="conflict"]').classList.remove("hidden");
      }
      list.append(item);
    });

    $("#empty-state").classList.toggle("hidden", activities.length > 0);
    $("#stop-count").textContent = activities.length;
    $("#total-cost").textContent = currency(activities.reduce((sum, item) => sum + item.cost, 0));
    $("#notice").classList.toggle("hidden", conflicts.size === 0);
    if (conflicts.size) showNotice(`${conflicts.size} timing ${conflicts.size === 1 ? "clash needs" : "clashes need"} attention.`);

    if (chronological.length) {
      const firstStart = activityStartMinutes(chronological[0]) - chronological[0].travelTime;
      const lastEnd = Math.max(...chronological.map((activity) => activityStartMinutes(activity) + activity.duration));
      $("#day-span").textContent = formatDuration(lastEnd - firstStart);
    } else {
      $("#day-span").textContent = "—";
    }
    save();
  }

  function resetForm() {
    form.reset();
    $("#activity-id").value = "";
    $("#start-time").value = "10:00";
    $("#start-day").value = "0";
    $("#duration").value = "60";
    $("#travel-time").value = "15";
    $("#cost").value = "0";
    $("#travel-mode").value = "transit";
    pendingOptionCoordinates = null;
    $("#submit-label").textContent = "Add to the day";
    $("#cancel-edit").classList.add("hidden");
  }

  function editActivity(id) {
    const item = state.activities.find((activity) => activity.id === id);
    if (!item) return;
    $("#activity-id").value = item.id;
    $("#activity-name").value = item.name;
    $("#activity-location").value = item.location || "";
    $("#start-time").value = item.startTime;
    $("#start-day").value = String(item.dayOffset || 0);
    $("#duration").value = item.duration;
    $("#travel-time").value = item.travelTime;
    $("#cost").value = item.cost;
    $("#category").value = item.category;
    $("#notes").value = item.notes;
    $("#travel-mode").value = item.travelMode || "transit";
    $("#submit-label").textContent = "Save changes";
    $("#cancel-edit").classList.remove("hidden");
    $("#activity-name").focus();
    if (window.innerWidth < 850) $(".activity-panel").scrollIntoView({ behavior: "smooth" });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#activity-id").value;
    const activity = {
      id: id || generateId(),
      name: $("#activity-name").value.trim(),
      startTime: $("#start-time").value,
      dayOffset: Number($("#start-day").value),
      duration: Number($("#duration").value),
      travelTime: Number($("#travel-time").value),
      cost: Number($("#cost").value),
      category: $("#category").value,
      notes: $("#notes").value.trim(),
      location: $("#activity-location").value.trim(),
      travelMode: $("#travel-mode").value
    };
    if (!activity.name || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(activity.startTime)) {
      showNotice("Add an activity name and a valid start time.");
      return;
    }
    if (![0, 1].includes(activity.dayOffset)) {
      showNotice("Choose whether the activity starts on the plan day or the next day.");
      return;
    }
    if (!Number.isFinite(activity.duration) || activity.duration <= 0 || activity.duration > 1440) {
      showNotice("Choose a duration between 1 minute and 24 hours.");
      return;
    }
    if (!Number.isFinite(activity.travelTime) || activity.travelTime < 0 || activity.travelTime > 1440) {
      showNotice("Choose travel time between 0 minutes and 24 hours.");
      return;
    }
    if (!Number.isFinite(activity.cost) || activity.cost < 0 || activity.cost > 100000) {
      showNotice("Enter an estimated cost between £0 and £100,000.");
      return;
    }
    const existing = id ? state.activities.find((item) => item.id === id) : null;
    if (existing && locationFor(existing) === locationFor(activity)) activity.coordinates = existing.coordinates;
    if (!existing && pendingOptionCoordinates?.query === activity.location) activity.coordinates = { ...pendingOptionCoordinates };
    clearUndo();

    if (id) {
      const index = state.activities.findIndex((item) => item.id === id);
      if (index >= 0) state.activities[index] = activity;
    } else {
      state.activities.push(activity);
    }
    resetForm();
    render();
  });

  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const item = event.target.closest("li[data-id]");
    if (!button || !item) return;
    if (button.dataset.action === "edit") editActivity(item.dataset.id);
    if (button.dataset.action === "delete") {
      rememberUndo(`Removed ${state.activities.find((activity) => activity.id === item.dataset.id)?.name || "a stop"}.`);
      state.activities = state.activities.filter((activity) => activity.id !== item.dataset.id);
      if ($("#activity-id").value === item.dataset.id) resetForm();
      render();
    }
  });

  ["plan-name", "plan-date", "starting-point"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => {
      clearUndo();
      state.details.name = $("#plan-name").value;
      state.details.date = $("#plan-date").value;
      state.details.startingPoint = $("#starting-point").value;
      if (id === "starting-point") state.details.startingCoordinates = null;
      save();
    });
  });

  $("#trip-diameter").addEventListener("change", () => {
    const input = $("#trip-diameter");
    const entered = Number(input.value);
    const normalized = Number.isFinite(entered) ? Math.min(100, Math.max(1, Math.round(entered))) : 5;
    input.value = String(normalized);
    state.details.diameter = normalized;
    clearUndo();
    save();
    if (entered !== normalized) showNotice(`Day-out diameter was adjusted to ${normalized} miles.`);
  });

  $("#starting-point").addEventListener("change", () => {
    if (!$("#explore-area").value.trim()) $("#explore-area").value = $("#starting-point").value.trim();
  });

  $("#explore-area").addEventListener("input", () => {
    customExploreCenter = null;
  });

  $("#explore-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("#explore-area").value.trim();
    if (!query) {
      setExploreStatus("Enter an area or starting point before searching.", true);
      $("#explore-area").focus();
      return;
    }
    if (query.toLocaleLowerCase() === "current location" && !customExploreCenter) {
      setExploreStatus("“Current location” is reserved for coordinates supplied by the Use my location button.", true);
      $("#use-location").focus();
      return;
    }
    if (customExploreCenter && query === "Current location") {
      await searchNearby(customExploreCenter);
      return;
    }
    setExploreBusy(true);
    setExploreStatus(`Finding ${query}…`);
    try {
      const center = await geocodeArea(query);
      customExploreCenter = null;
      await searchNearby(center);
    } catch (error) {
      setExploreStatus(error.message || "That area could not be found.", true);
      setExploreBusy(false);
    }
  });

  $("#use-location").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setExploreStatus("Location is not available in this browser. Search by area instead.", true);
      return;
    }
    setExploreBusy(true);
    setExploreStatus("Waiting for your location permission…");
    navigator.geolocation.getCurrentPosition(async (position) => {
      customExploreCenter = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        label: "your current location"
      };
      $("#explore-area").value = "Current location";
      await searchNearby(customExploreCenter);
    }, (error) => {
      const denied = error.code === error.PERMISSION_DENIED;
      setExploreStatus(denied
        ? "Location permission was not granted. Search by area instead."
        : "Your location could not be determined. Search by area instead.", true);
      setExploreBusy(false);
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });

  $("#cancel-edit").addEventListener("click", resetForm);
  $("#clear-plan").addEventListener("click", () => {
    if (!state.activities.length || window.confirm("Remove every stop from this plan?")) {
      if (state.activities.length) rememberUndo("Cleared all stops.");
      state.activities = [];
      resetForm();
      render();
    }
  });

  $("#sample-plan").addEventListener("click", () => {
    if (state.activities.length && !window.confirm("Replace the current stops with an example day?")) return;
    rememberUndo(state.activities.length ? "Replaced your stops with the example." : "Loaded the example day.");
    state.details = { name: "Saturday in the city", date: state.details.date, startingPoint: "Central Station, London", diameter: 6, ranking: "time", startingCoordinates: null };
    state.activities = [
      { id: generateId(), name: "Borough Market", location: "Borough Market, London", startTime: "09:30", duration: 90, travelTime: 15, travelMode: "transit", cost: 0, category: "Shopping", notes: "Browse the food stalls and small makers." },
      { id: generateId(), name: "Lunch at the garden café", location: "Garden Museum, London", startTime: "11:30", duration: 75, travelTime: 20, travelMode: "bicycling", cost: 22.5, category: "Food & drink", notes: "Outdoor tables if the weather is kind." },
      { id: generateId(), name: "Tate Modern", location: "Tate Modern, London", startTime: "13:15", duration: 120, travelTime: 15, travelMode: "walking", cost: 14, category: "Attraction", notes: "Check the current exhibition before setting off." },
      { id: generateId(), name: "Walk through St James's Park", location: "St James's Park, London", startTime: "15:45", duration: 60, travelTime: 10, travelMode: "transit", cost: 0, category: "Outdoors", notes: "Finish near the west gate." }
    ];
    syncDetailInputs();
    render();
  });

  $("#undo-action").addEventListener("click", () => {
    if (!undoState) return;
    state.details = undoState.details;
    state.activities = undoState.activities;
    clearUndo();
    resetForm();
    syncDetailInputs();
    render();
  });

  $("#rank-order").addEventListener("change", () => {
    state.details.ranking = $("#rank-order").value;
    render();
  });

  function haversineMiles(a, b) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 3958.8 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function pause(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function geocode(query) {
    const cacheKey = query.trim().toLocaleLowerCase();
    const failedAt = failedGeocodes.get(cacheKey);
    if (failedAt && Date.now() - failedAt < FAILED_GEOCODE_TTL_MS) return null;
    if (failedAt) failedGeocodes.delete(cacheKey);
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    try {
      const response = await fetch(url, { headers: { "Accept-Language": navigator.language || "en" } });
      if (!response.ok) throw new Error("Location lookup failed");
      const results = await response.json();
      if (!results.length) {
        failedGeocodes.set(cacheKey, Date.now());
        return null;
      }
      return { lat: Number(results[0].lat), lon: Number(results[0].lon), query };
    } finally {
      await pause(1100);
    }
  }

  async function locatePlan() {
    const items = [];
    const missing = [];
    const startingQuery = state.details.startingPoint.trim();
    if (startingQuery) {
      if (!state.details.startingCoordinates || state.details.startingCoordinates.query !== startingQuery) {
        state.details.startingCoordinates = await geocode(startingQuery);
      }
      if (state.details.startingCoordinates) items.push({ name: "Start", ...state.details.startingCoordinates, isStart: true });
      else missing.push("starting point");
    }
    for (const activity of sortedActivities()) {
      const query = locationFor(activity);
      if (!activity.coordinates || activity.coordinates.query !== query) {
        activity.coordinates = await geocode(query);
      }
      if (activity.coordinates) items.push({ name: activity.name, ...activity.coordinates, activity });
      else missing.push(activity.name);
    }
    save();
    return { points: items, missing };
  }

  function loadMapLibrary() {
    if (window.L) return Promise.resolve();
    if (mapLibraryPromise) return mapLibraryPromise;
    mapLibraryPromise = new Promise((resolve, reject) => {
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.append(stylesheet);
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("The map library could not load"));
      document.head.append(script);
    }).catch((error) => {
      mapLibraryPromise = null;
      throw error;
    });
    return mapLibraryPromise;
  }

  function drawMap(points) {
    const container = $("#trip-map");
    if (!window.L) {
      container.innerHTML = '<div class="map-placeholder"><span>!</span><p>The map library could not load. Directions still work.</p></div>';
      return;
    }
    if (!map) {
      container.replaceChildren();
      map = window.L.map(container);
      window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
    }
    if (mapLayer) mapLayer.remove();
    mapLayer = window.L.featureGroup().addTo(map);
    const start = points.find((point) => point.isStart) || points[0];
    points.forEach((point, index) => {
      const distance = start ? haversineMiles(start, point) : 0;
      const marker = window.L.marker([point.lat, point.lon]).addTo(mapLayer);
      marker.bindPopup(`<div class="map-label"><strong>${index + 1}. ${point.name.replace(/[<>&]/g, "")}</strong><span>${point.isStart ? "Starting point" : `${distance.toFixed(1)} miles from start`}</span></div>`);
    });
    if (points.length > 1) {
      window.L.polyline(points.map((point) => [point.lat, point.lon]), {
        color: "#e97945", weight: 3, opacity: 0.75, dashArray: "7 7"
      }).addTo(mapLayer);
    }
    if (start) {
      window.L.circle([start.lat, start.lon], {
        radius: (state.details.diameter / 2) * 1609.344,
        color: "#315c49", fillColor: "#dbea90", fillOpacity: 0.12, weight: 2
      }).addTo(mapLayer);
    }
    const pointBounds = window.L.latLngBounds(points.map((point) => [point.lat, point.lon]));
    if (points.length === 1) map.setView([points[0].lat, points[0].lon], 13);
    else map.fitBounds(pointBounds.pad(0.15), { maxZoom: 14 });
    window.setTimeout(() => map.invalidateSize(), 0);
  }

  function weatherDescription(code) {
    if (code === 0) return ["☀", "Clear skies"];
    if (code <= 3) return ["◑", "Some cloud"];
    if ([45, 48].includes(code)) return ["≋", "Foggy"];
    if (code >= 71 && code <= 77) return ["❄", "Snow likely"];
    if (code >= 95) return ["ϟ", "Thunderstorms possible"];
    if (code >= 51 && code <= 67 || code >= 80 && code <= 82) return ["☂", "Rain likely"];
    return ["◌", "Mixed conditions"];
  }

  async function updateWeather(point) {
    const panel = $("#weather-advice");
    const date = state.details.date;
    if (!date) {
      panel.innerHTML = '<span class="weather-icon">◌</span><div><strong>Choose a date</strong><p>Add the day of your trip to check its forecast.</p></div>';
      return;
    }
    const chosen = new Date(`${date}T12:00:00`);
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const daysAway = Math.round((chosen - today) / 86400000);
    if (daysAway < 0 || daysAway > 15) {
      panel.innerHTML = '<span class="weather-icon">◌</span><div><strong>Forecast not available yet</strong><p>Live advice is available from today up to 15 days ahead.</p></div>';
      return;
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", point.lat);
    url.searchParams.set("longitude", point.lon);
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("start_date", date);
    url.searchParams.set("end_date", date);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Forecast lookup failed");
    const data = await response.json();
    const code = data.daily.weather_code[0];
    const rain = data.daily.precipitation_probability_max[0];
    const high = Math.round(data.daily.temperature_2m_max[0]);
    const low = Math.round(data.daily.temperature_2m_min[0]);
    const wind = Math.round(data.daily.wind_speed_10m_max[0]);
    const [icon, summary] = weatherDescription(code);
    const advice = [];
    if (rain >= 45) advice.push("pack a waterproof");
    if (high >= 24) advice.push("take water and sun protection");
    if (low <= 8) advice.push("bring a warm layer");
    if (wind >= 35) advice.push("allow for strong wind");
    if (!advice.length) advice.push("conditions look comfortable for a day out");
    panel.innerHTML = `<span class="weather-icon">${icon}</span><div><strong>${summary} · ${low}–${high}°C</strong><p>${rain}% rain · wind up to ${wind} km/h · ${advice.join("; ")}.</p></div>`;
  }

  $("#refresh-insights").addEventListener("click", async () => {
    const button = $("#refresh-insights");
    const status = $("#map-status");
    if (!state.details.startingPoint.trim() && !state.activities.length) {
      status.textContent = "Add a starting point or at least one stop first.";
      return;
    }
    button.disabled = true;
    const unlockPlannerInputs = lockPlannerInputs();
    button.textContent = "Finding your stops…";
    status.textContent = "Looking up locations; this can take a few seconds.";
    try {
      const mapReady = loadMapLibrary();
      const { points, missing } = await locatePlan();
      if (!points.length) throw new Error("No locations could be found");
      await mapReady;
      drawMap(points);
      const start = points.find((point) => point.isStart) || points[0];
      const limit = state.details.diameter / 2;
      const outside = points.filter((point) => !point.isStart && haversineMiles(start, point) > limit);
      const radiusMessage = outside.length
        ? `${outside.length} ${outside.length === 1 ? "stop is" : "stops are"} outside the ${state.details.diameter}-mile diameter: ${outside.map((point) => point.name).join(", ")}.`
        : `Every mapped stop fits within the ${state.details.diameter}-mile diameter.`;
      status.textContent = missing.length ? `${radiusMessage} Could not map: ${missing.join(", ")}.` : radiusMessage;
      await updateWeather(start);
    } catch (error) {
      status.textContent = `${error.message}. Check the place names and your connection, then try again.`;
    } finally {
      unlockPlannerInputs();
      button.disabled = false;
      button.textContent = "Update map & weather";
    }
  });

  document.querySelector(".route-options").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-route-mode]");
    if (!button) return;
    const stops = sortedActivities().map(locationFor);
    if (!stops.length) {
      $("#map-status").textContent = "Add at least one stop to open directions.";
      return;
    }
    const destination = stops.pop();
    window.open(directionsUrl(state.details.startingPoint, destination, button.dataset.routeMode, stops), "_blank", "noopener");
  });

  function externalStateFromRaw(raw) {
    if (raw === null) {
      return {
        details: { name: "A lovely day out", date: "", startingPoint: "", diameter: 5, startingCoordinates: null },
        activities: [],
        _revision: persistedRevision + 1
      };
    }
    const saved = JSON.parse(raw);
    if (!saved || !saved.details || !Array.isArray(saved.activities)) throw new Error("Invalid external plan");
    return saved;
  }

  function preserveConflictVersion(raw, label) {
    if (raw === null) return true;
    const prefix = `${STORAGE_KEY}-conflict-`;
    const key = `${prefix}${label}-${Date.now()}`;
    try {
      const backups = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const existingKey = localStorage.key(index);
        if (existingKey?.startsWith(prefix)) backups.push(existingKey);
      }
      backups.sort((a, b) => Number(a.split("-").at(-1)) - Number(b.split("-").at(-1)));
      while (backups.length >= 3) localStorage.removeItem(backups.shift());
      try {
        localStorage.setItem(key, raw);
      } catch (error) {
        while (backups.length) {
          localStorage.removeItem(backups.shift());
          try {
            localStorage.setItem(key, raw);
            return true;
          } catch (retryError) {
            // Continue freeing only older conflict backups before using the download fallback.
          }
        }
        throw error;
      }
      return true;
    } catch (error) {
      try {
        const blob = new Blob([raw], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `daylight-${label}-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        showNotice("Browser storage was full, so the displaced plan was downloaded as a recovery file.");
        return true;
      } catch (downloadError) {
        showNotice("The conflicting plan could not be backed up or downloaded, so no version was overwritten.");
        return false;
      }
    }
  }

  function recoveryKeys() {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === RECOVERY_KEY || key?.startsWith(`${STORAGE_KEY}-conflict-`)) keys.push(key);
    }
    return keys.sort().reverse();
  }

  function downloadRecovery(raw, label = "recovery") {
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `daylight-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderRecoveryManager() {
    const container = $("#recovery-list");
    container.replaceChildren();
    let keys;
    try {
      keys = recoveryKeys();
    } catch (error) {
      const message = document.createElement("p");
      message.className = "recovery-empty";
      message.textContent = "Browser storage is unavailable, so recovery copies cannot be listed.";
      container.append(message);
      return;
    }
    if (!keys.length) {
      const empty = document.createElement("p");
      empty.className = "recovery-empty";
      empty.textContent = "No recovery copies are stored.";
      container.append(empty);
      return;
    }
    keys.forEach((key) => {
      const raw = localStorage.getItem(key);
      const item = document.createElement("div");
      item.className = "recovery-item";
      const summary = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      try {
        const saved = JSON.parse(raw);
        title.textContent = saved?.details?.name || "Unnamed plan";
        detail.textContent = `${Array.isArray(saved?.activities) ? saved.activities.length : 0} stops · ${key === RECOVERY_KEY ? "damaged-state backup" : "cross-tab backup"}`;
      } catch (error) {
        title.textContent = "Damaged plan data";
        detail.textContent = "Download this copy for manual recovery";
      }
      summary.append(title, detail);
      const actions = document.createElement("div");
      actions.className = "recovery-item-actions";
      [
        ["restore", "Restore"],
        ["download", "Download"],
        ["delete", "Delete"]
      ].forEach(([action, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.dataset.key = key;
        button.textContent = label;
        actions.append(button);
      });
      item.append(summary, actions);
      container.append(item);
    });
  }

  $("#open-recovery").addEventListener("click", () => {
    renderRecoveryManager();
    $("#recovery-manager").classList.remove("hidden");
  });

  $("#close-recovery").addEventListener("click", () => {
    $("#recovery-manager").classList.add("hidden");
  });

  $("#recovery-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const key = button.dataset.key;
    const raw = localStorage.getItem(key);
    if (raw === null) {
      showNotice("That recovery copy no longer exists.");
      renderRecoveryManager();
      return;
    }
    if (button.dataset.action === "download") {
      downloadRecovery(raw);
      return;
    }
    if (button.dataset.action === "delete") {
      localStorage.removeItem(key);
      renderRecoveryManager();
      return;
    }
    try {
      const saved = JSON.parse(raw);
      if (!saved?.details || !Array.isArray(saved.activities) || saved.activities.some((activity) => !normalizedActivity(activity))) {
        showNotice("This copy contains invalid records and cannot be restored automatically. Download it for manual recovery instead.");
        return;
      }
      const currentRaw = localStorage.getItem(STORAGE_KEY);
      if (currentRaw && currentRaw !== raw && !preserveConflictVersion(currentRaw, "before-restore")) return;
      lastSavedRaw = currentRaw;
      try {
        const current = currentRaw ? JSON.parse(currentRaw) : null;
        persistedRevision = Number.isInteger(current?._revision) ? current._revision : persistedRevision;
      } catch (error) {
        // The current malformed primary value has already been preserved above.
      }
      applySavedState(saved);
      storageCanSave = true;
      damagedStatePending = false;
      clearStorageConflict();
      clearUndo();
      resetForm();
      syncDetailInputs();
      render();
      $("#use-repaired-plan").classList.add("hidden");
      $("#recovery-manager").classList.add("hidden");
      showNotice("Recovery copy restored. The displaced primary plan was preserved separately.");
    } catch (error) {
      showNotice("This recovery copy could not be restored. Download it for manual recovery instead.");
    }
  });

  $("#use-repaired-plan").addEventListener("click", () => {
    storageCanSave = true;
    damagedStatePending = false;
    $("#use-repaired-plan").classList.add("hidden");
    save();
    showNotice("The repaired plan is now active. The original damaged data remains available under Recovery copies.");
  });

  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || event.key !== STORAGE_KEY || event.newValue === lastSavedRaw) return;
    showStorageConflict(event.newValue);
  });

  $("#load-external-plan").addEventListener("click", () => {
    try {
      const localRaw = JSON.stringify({ ...state, _revision: persistedRevision });
      if (!preserveConflictVersion(localRaw, "local")) return;
      const external = externalStateFromRaw(pendingExternalRaw);
      applySavedState(external);
      persistedRevision = Number.isInteger(external._revision) ? external._revision : persistedRevision + 1;
      lastSavedRaw = pendingExternalRaw;
      clearStorageConflict();
      clearUndo();
      resetForm();
      syncDetailInputs();
      render();
      showNotice("Loaded the newer plan. A recovery copy of this tab’s previous version was preserved.");
    } catch (error) {
      showNotice("The newer plan could not be loaded, so this tab was left unchanged.");
    }
  });

  $("#keep-local-plan").addEventListener("click", () => {
    try {
      if (!preserveConflictVersion(pendingExternalRaw, "external")) return;
      const external = externalStateFromRaw(pendingExternalRaw);
      persistedRevision = Math.max(persistedRevision, Number.isInteger(external._revision) ? external._revision : 0);
      lastSavedRaw = pendingExternalRaw;
      clearStorageConflict();
      save();
      showNotice("Kept this tab’s plan. A recovery copy of the other version was preserved.");
    } catch (error) {
      showNotice("The conflicting plan could not be read, so no version was overwritten.");
    }
  });

  const storageNotice = load();
  syncDetailInputs();
  render();
  $("#use-repaired-plan").classList.toggle("hidden", !damagedStatePending);
  if (storageNotice) showNotice(storageNotice);
})();
