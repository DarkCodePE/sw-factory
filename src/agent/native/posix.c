// Small Node-API bridge: the compiler handles Darwin's variadic openat ABI.
// All paths are single components validated by the TypeScript capability layer.
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value result(napi_env env, int value) {
  napi_value output;
  napi_create_int32(env, value < 0 ? -errno : value, &output);
  return output;
}
static int integer(napi_env env, napi_value value, int *number) {
  return napi_get_value_int32(env, value, number) == napi_ok;
}
static char *string(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > 4096) return NULL;
  char *text = malloc(length + 1);
  if (!text) return NULL;
  if (napi_get_value_string_utf8(env, value, text, length + 1, &length) != napi_ok) { free(text); return NULL; }
  return text;
}
static napi_value open_at(napi_env env, napi_callback_info info) {
  napi_value args[4]; size_t count = 4; int fd, flags, mode;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 4 || !integer(env,args[0],&fd) || !integer(env,args[2],&flags) || !integer(env,args[3],&mode)) { errno=EINVAL; return result(env,-1); }
  char *name = string(env,args[1]); if (!name) { errno=EINVAL; return result(env,-1); }
  int value = openat(fd, name, flags | O_CLOEXEC, (mode_t)mode), saved = errno;
  free(name); errno=saved; return result(env,value);
}
static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; int fd, mode;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 3 || !integer(env,args[0],&fd) || !integer(env,args[2],&mode)) { errno=EINVAL; return result(env,-1); }
  char *name = string(env,args[1]); if (!name) { errno=EINVAL; return result(env,-1); }
  int value = mkdirat(fd,name,(mode_t)mode), saved = errno;
  free(name); errno=saved; return result(env,value);
}
static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count=3; int fd;
  napi_get_cb_info(env,info,&count,args,NULL,NULL);
  if (count != 3 || !integer(env,args[0],&fd)) { errno=EINVAL; return result(env,-1); }
  char *from=string(env,args[1]), *to=string(env,args[2]);
  if (!from || !to) { free(from); free(to); errno=EINVAL; return result(env,-1); }
  int value=renameat(fd,from,fd,to), saved=errno;
  free(from); free(to); errno=saved; return result(env,value);
}
static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count=2; int fd;
  napi_get_cb_info(env,info,&count,args,NULL,NULL);
  if (count != 2 || !integer(env,args[0],&fd)) { errno=EINVAL; return result(env,-1); }
  char *name=string(env,args[1]); if (!name) { errno=EINVAL; return result(env,-1); }
  int value=unlinkat(fd,name,0), saved=errno; free(name); errno=saved; return result(env,value);
}
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env,"openAt",NAPI_AUTO_LENGTH,open_at,NULL,&fn); napi_set_named_property(env,exports,"openAt",fn);
  napi_create_function(env,"mkdirAt",NAPI_AUTO_LENGTH,mkdir_at,NULL,&fn); napi_set_named_property(env,exports,"mkdirAt",fn);
  napi_create_function(env,"renameAt",NAPI_AUTO_LENGTH,rename_at,NULL,&fn); napi_set_named_property(env,exports,"renameAt",fn);
  napi_create_function(env,"unlinkAt",NAPI_AUTO_LENGTH,unlink_at,NULL,&fn); napi_set_named_property(env,exports,"unlinkAt",fn);
  return exports;
}
