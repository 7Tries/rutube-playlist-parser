@echo off
chcp 65001 >nul
echo ===================================================
echo   Запуск Rutube Playlist Parser...
echo ===================================================

:: Проверка и автоустановка зависимостей
python -c "import uvicorn, fastapi" 2>nul
if %errorlevel% neq 0 (
    echo [*] Не найдены необходимые библиотеки (fastapi, uvicorn).
    echo [*] Выполняется установка из requirements.txt...
    python -m pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo.
        echo [!] Ошибка при установке библиотек.
        echo [!] Убедитесь, что интернет подключен, и попробуйте команду:
        echo     pip install -r requirements.txt
        echo.
        pause
        exit /b 1
    )
)

python run.py
pause
