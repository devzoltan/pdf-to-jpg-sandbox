#!/bin/sh
# Hard runtime limit inside the container itself, independent of the backend.
exec timeout -s KILL "${PDF2JPG_HARD_TIMEOUT_S:-75}" /usr/local/bin/convert.sh
