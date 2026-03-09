/**
 * Nuvio Plugin: YouTube Direct + GitHub Repos
 * Sources streams from two places:
 *   1. YouTube search via Piped API (direct)
 *   2. GitHub repo READMEs — scans top repos mentioning the title for YouTube links
 * No API keys required.
 */

"use strict";

// ─── TMDB → Title ────────────────────────────────────────────────────────────

function getTmdbTitle(tmdbId, mediaType) {
  var url =
    "https://api.themoviedb.org/3/" +
    (mediaType === "tv" ? "tv" : "movie") +
    "/" +
    tmdbId +
    "?api_key=4ef0d7355d9ffb5151e987764708ce96";

  return fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (data) { return data.title || data.name || tmdbId; })
    .catch(function () { return tmdbId; });
}

// ─── YouTube Search via Piped ─────────────────────────────────────────────────

function searchYouTube(query) {
  var url =
    "https://pipedapi.kavin.rocks/search?q=" +
    encodeURIComponent(query) +
    "&filter=videos";

  return fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error("Piped search failed: " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data.items || data.items.length === 0) return [];
      return data.items
        .filter(function (item) { return item.url && item.type === "stream"; })
        .slice(0, 6)
        .map(function (item) {
          return {
            id: item.url.replace("/watch?v=", ""),
            title: item.title || "YouTube Video",
            duration: item.duration || 0,
            views: item.views || 0,
            uploaderName: item.uploaderName || "",
          };
        });
    })
    .catch(function (err) {
      console.log("[YT-Direct] Search error: " + err.message);
      return [];
    });
}

// ─── Resolve Video ID → Stream URLs ──────────────────────────────────────────

function resolveStream(video) {
  var url = "https://pipedapi.kavin.rocks/streams/" + video.id;

  return fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error("Stream resolve failed: " + res.status);
      return res.json();
    })
    .then(function (data) {
      var streams = [];
      var headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      };

      // Muxed (audio + video) streams — best for direct playback
      if (data.videoStreams && data.videoStreams.length > 0) {
        var muxed = data.videoStreams
          .filter(function (s) { return s.url && s.videoOnly === false; })
          .sort(function (a, b) {
            return (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0);
          });

        muxed.slice(0, 2).forEach(function (s) {
          streams.push({
            name: "YouTube",
            title: video.title + " [" + (s.quality || "?") + "]",
            url: s.url,
            quality: s.quality || "Unknown",
            headers: headers,
          });
        });
      }

      // HLS fallback
      if (streams.length === 0 && data.hls) {
        streams.push({
          name: "YouTube",
          title: video.title + " [HLS]",
          url: data.hls,
          quality: "Auto",
          headers: headers,
        });
      }

      return streams;
    })
    .catch(function (err) {
      console.log("[YT-Direct] Resolve error for " + video.id + ": " + err.message);
      return [];
    });
}

// ─── GitHub Repo Scraper ──────────────────────────────────────────────────────

function extractYouTubeIds(text) {
  var ids = [];
  var seen = {};
  var pattern = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([A-Za-z0-9_-]{11})/g;
  var match;
  while ((match = pattern.exec(text)) !== null) {
    var id = match[1];
    if (!seen[id]) { seen[id] = true; ids.push(id); }
  }
  return ids;
}

function fetchRepoReadme(fullName) {
  return fetch("https://raw.githubusercontent.com/" + fullName + "/HEAD/README.md")
    .then(function (res) { return res.ok ? res.text() : ""; })
    .catch(function () { return ""; });
}

function searchGitHubRepos(title) {
  var url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(title + " youtube") +
    "&per_page=8&sort=stars";

  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "NuvioPlugin/1.0",
    },
  })
    .then(function (res) {
      if (!res.ok) throw new Error("GitHub search failed: " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data.items || data.items.length === 0) return [];
      var readmeFetches = data.items.slice(0, 5).map(function (repo) {
        return fetchRepoReadme(repo.full_name);
      });
      return Promise.all(readmeFetches).then(function (texts) {
        var seen = {};
        var ids = [];
        texts.forEach(function (text) {
          extractYouTubeIds(text).forEach(function (id) {
            if (!seen[id]) { seen[id] = true; ids.push(id); }
          });
        });
        console.log("[YT-Direct] GitHub repos yielded " + ids.length + " video IDs");
        return ids;
      });
    })
    .catch(function (err) {
      console.log("[YT-Direct] GitHub repo search error: " + err.message);
      return [];
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[YT-Direct] tmdbId=" + tmdbId + " type=" + mediaType + " s=" + season + " e=" + episode);

  return getTmdbTitle(tmdbId, mediaType)
    .then(function (title) {
      console.log("[YT-Direct] Title: " + title);

      var query = title;
      if (mediaType === "tv" && season && episode) {
        query += " Season " + season + " Episode " + episode + " full episode";
      } else {
        query += " full movie";
      }

      console.log("[YT-Direct] Searching YouTube + GitHub repos for: " + query);

      // Run both sources in parallel
      return Promise.all([
        searchYouTube(query),
        searchGitHubRepos(title),
      ]);
    })
    .then(function (results) {
      var ytVideos = results[0];      // [{id, title, ...}, ...]
      var repoIds  = results[1];      // ["videoId", ...]

      // Convert raw GitHub repo IDs into video objects (title fetched during resolve)
      var seen = {};
      ytVideos.forEach(function (v) { seen[v.id] = true; });

      var repoVideos = repoIds
        .filter(function (id) { return !seen[id]; })
        .slice(0, 4)
        .map(function (id) {
          return { id: id, title: "GitHub Repo Find", source: "github" };
        });

      var allVideos = ytVideos.concat(repoVideos);
      console.log("[YT-Direct] Total videos to resolve: " + allVideos.length);

      if (allVideos.length === 0) return [];

      return Promise.all(
        allVideos.map(function (v) { return resolveStream(v); })
      ).then(function (arrays) {
        var all = [];
        arrays.forEach(function (arr) {
          arr.forEach(function (s) { all.push(s); });
        });
        console.log("[YT-Direct] Returning " + all.length + " total streams");
        return all;
      });
    })
    .catch(function (err) {
      console.log("[YT-Direct] Fatal: " + err.message);
      return [];
    });
}

module.exports = { getStreams: getStreams };
