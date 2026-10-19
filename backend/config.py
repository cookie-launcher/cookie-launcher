#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Launcher genel yapılandırması.

Cloudflare Worker deploy edildikten sonra `DEFAULT_RENDEZVOUS_URL` alanına
`https://cookie-launcher-rendezvous.<subdomain>.workers.dev` yazılabilir.
Boş bırakılırsa kısa kod yerine uzun (endpoint gömülü) CL1 kodu kullanılır.
`COOKIE_LAUNCHER_RENDEZVOUS_URL` ortam değişkeni bu değeri ezer.
"""

DEFAULT_RENDEZVOUS_URL = "https://cookie-launcher-rendezvous.emregunduz016-53b.workers.dev"
