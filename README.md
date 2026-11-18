# Fonix Music

Widget de música para a área de trabalho do Windows. Mostra o que está tocando, controla a reprodução e guarda uma biblioteca local das faixas.

![Fonix Music](build/icon.png)

## O que é

O **Fonix Music** é um balão transparente que fica na área de trabalho (atrás das janelas) ou sempre no topo. Ele se conecta ao que o Windows está tocando — YouTube no Brave/Chrome/Edge, Spotify e arquivos do PC — e mostra título, artista, capa e progresso.

## Funções

- **Controle de mídia**: play/pause, anterior, próxima e volume do sistema
- **YouTube e Spotify**: lê título, artista e capa pelo Windows SMTC
- **Arquivos locais**: abre pastas/arquivos (MP3, FLAC, WAV, M4A…) e toca no próprio app
- **Biblioteca**: salva automaticamente as músicas tocadas; o coração guarda curtidas
- **Abrir na origem**: clique no título ou na capa para abrir no YouTube, Spotify (app/web) ou no arquivo local
- **Temas**: Anime Glass e Vidro Holográfico
- **Área de trabalho**: modo preso à área de trabalho ou sempre no topo
- **Ajustes**: opacidade, tamanho, travar posição, iniciar com o Windows
- **Bandeja**: menu completo pelo ícone ou clique direito no balão

## Como usar

### Desenvolvimento

```bash
npm install
npm start
```

### Executável

```bash
npm run dist
```

Gera:

- `dist/Fonix Music Setup.exe` — instalador
- `dist/FonixMusic.exe` — versão portátil

## Atalhos rápidos

| Ação | Como |
|------|------|
| Arrastar | Clique e arraste o balão (exceto nos botões) |
| Menu | Clique direito no balão ou no ícone da bandeja |
| Biblioteca | Menu → Biblioteca |
| Curtir | Coração no canto do balão |
| Abrir música | Clique no título ou na capa |

## Tecnologias

- Electron
- Windows SMTC (mídia do sistema)
- music-metadata (tags e capas locais)
- iTunes Search (capa/título quando o Windows não envia)

## Licença

Uso pessoal / projeto open source.
