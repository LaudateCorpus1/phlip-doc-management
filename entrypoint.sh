#!/bin/bash

echo "Starting LibreOffice listener"
unoconv --listener &
npm run start:local