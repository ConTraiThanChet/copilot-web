// relay-inject.so — LD_PRELOAD shim for the GitHub Copilot desktop app (WebKitGTK).
//
//  * Appends the Copilot Web relay script to Tauri's IPC init script, so the
//    app's main webview can execute IPC calls for browser clients.
//  * With COPILOT_WEB_HEADLESS_UI=1, app pages (tauri://localhost/...) are
//    loaded as the empty /blank.html instead of the full React UI. The webview
//    then only hosts the IPC relay, which keeps memory use low; the real UI
//    runs in the user's browser.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void *(*user_script_new_fn)(const char *, int, int, const char *const *, const char *const *);
typedef void (*load_uri_fn)(void *, const char *);
typedef void (*load_request_fn)(void *, void *);
typedef const char *(*request_get_uri_fn)(void *);
typedef void (*request_set_uri_fn)(void *, const char *);

static char *relay_source = NULL;
static int relay_loaded = 0;

static void load_relay(void) {
  if (relay_loaded) return;
  relay_loaded = 1;
  const char *path = getenv("COPILOT_WEB_RELAY_JS");
  if (!path || !*path) return;
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "[copilot-web] cannot open relay %s\n", path); return; }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  relay_source = malloc(n + 1);
  if (relay_source && fread(relay_source, 1, n, f) == (size_t)n) {
    relay_source[n] = 0;
  } else {
    free(relay_source);
    relay_source = NULL;
  }
  fclose(f);
}

void *webkit_user_script_new(const char *source, int injected_frames, int injection_time,
                             const char *const *allow_list, const char *const *block_list) {
  static user_script_new_fn real = NULL;
  if (!real) real = (user_script_new_fn)dlsym(RTLD_NEXT, "webkit_user_script_new");
  load_relay();
  if (relay_source && source && strstr(source, "__TAURI_INTERNALS__") && strstr(source, "'invoke'")) {
    size_t a = strlen(source), b = strlen(relay_source);
    char *combined = malloc(a + b + 2);
    if (combined) {
      memcpy(combined, source, a);
      combined[a] = '\n';
      memcpy(combined + a + 1, relay_source, b + 1);
      void *script = real(combined, injected_frames, injection_time, allow_list, block_list);
      free(combined);
      return script;
    }
  }
  return real(source, injected_frames, injection_time, allow_list, block_list);
}

static int headless_ui(void) {
  const char *v = getenv("COPILOT_WEB_HEADLESS_UI");
  return v && strcmp(v, "1") == 0;
}

// Returns a replacement URI for app pages, or NULL to keep the original.
static const char *rewrite_uri(const char *uri) {
  if (!uri || !headless_ui()) return NULL;
  const char *prefixes[] = {"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"};
  for (size_t i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) {
    size_t n = strlen(prefixes[i]);
    if (strncmp(uri, prefixes[i], n) == 0 && (uri[n] == 0 || uri[n] == '/' || uri[n] == '?' || uri[n] == '#')) {
      if (strstr(uri + n, "blank.html")) return NULL;
      static char buf[256];
      snprintf(buf, sizeof buf, "%s/blank.html", prefixes[i]);
      return buf;
    }
  }
  return NULL;
}

void webkit_web_view_load_uri(void *view, const char *uri) {
  static load_uri_fn real = NULL;
  if (!real) real = (load_uri_fn)dlsym(RTLD_NEXT, "webkit_web_view_load_uri");
  const char *r = rewrite_uri(uri);
  real(view, r ? r : uri);
}

void webkit_web_view_load_request(void *view, void *request) {
  static load_request_fn real = NULL;
  static request_get_uri_fn get_uri = NULL;
  static request_set_uri_fn set_uri = NULL;
  if (!real) real = (load_request_fn)dlsym(RTLD_NEXT, "webkit_web_view_load_request");
  if (!get_uri) get_uri = (request_get_uri_fn)dlsym(RTLD_DEFAULT, "webkit_uri_request_get_uri");
  if (!set_uri) set_uri = (request_set_uri_fn)dlsym(RTLD_DEFAULT, "webkit_uri_request_set_uri");
  if (get_uri && set_uri) {
    const char *r = rewrite_uri(get_uri(request));
    if (r) set_uri(request, r);
  }
  real(view, request);
}
