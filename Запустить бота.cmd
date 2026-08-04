@echo off
setlocal
cd /d "%~dp0"
echo Проверка зависимостей...
py -3 -m pip install -q "python-telegram-bot>=20.0" --upgrade
echo.
echo Запуск Finance Control Bot...
py -3 bot.py
pause
