"""
Wrapper for 'localstack' command-line script that listens to ports on localhost only, avoiding
warnings from MacOS about allowing Python to receive incoming network connections.
"""
# TODO: This is all a hack and would be better solved by submitting a patch to localstack to
# respect some environment variables for which address to listen on.
import runpy

from localstack.services import generic_proxy
from localstack import constants


# The following code monkey-patches the constructor for GenericProxy to default its `host`
# parameter to 'localhost' instead of ''. This parameter is not actually used by localstack at
# all, so the default is the value used. The reason for this is that listening on host '' binds
# all network interfaces, requiring on MacOS a warning from the Firewall whether to allow Python
# to receive incoming network connections. Using 'localhost' avoids that.
def patch_GenericProxy_init():
  orig_init = generic_proxy.GenericProxy.__init__

  def new_init(self, *args, **kwargs):
    kwargs.setdefault('host', 'localhost')
    orig_init(self, *args, **kwargs)

  generic_proxy.GenericProxy.__init__ = new_init


# Same kind of monkey patching is needed for serve_flask_app.
def patch_serve_flask_app():
  orig_serve = generic_proxy.serve_flask_app

  def new_serve(*args, **kwargs):
    kwargs.setdefault('host', 'localhost')
    orig_serve(*args, **kwargs)

  generic_proxy.serve_flask_app = new_serve


patch_GenericProxy_init()
patch_serve_flask_app()

# Also change BIND_HOST to use localhost instead of '0.0.0.0' (which also triggers the warning).
constants.BIND_HOST = 'localhost'

# Once patched, we run the localstack command-line script as if it were run directly.
runpy.run_path('venv/bin/localstack', run_name='__main__')
