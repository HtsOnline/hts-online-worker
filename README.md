# Sincronização de skins do HTS

Esta pasta guarda as versões de trabalho dos scripts de skin que vieram da pasta extraída. Os originais externos não foram alterados.

## O que foi preparado

- Materiais locais e materiais dos caminhões remotos são instâncias separadas, para uma textura não mudar outro caminhão que usa o mesmo prefab.
- Cada imagem é identificada pela categoria da peça e pelo `idTruck` do script: cabine, carroceria, detalhes, roda dianteira, roda traseira ou vidros.
- Na sala online, o jogo envia a imagem uma vez por versão. A sala anuncia o hash; cada cliente baixa a imagem uma vez e usa um cache temporário por sala e jogador. As imagens recebidas são validadas pelo SHA-256 antes de serem usadas.
- O Worker apaga as imagens do jogador quando a conexão dele termina. O cliente também apaga o cache temporário quando recebe a saída do jogador ou desconecta.
- A tela de seleção abre o seletor moderno do Android (`ACTION_GET_CONTENT`) e copia o resultado para o armazenamento privado do jogo. O Android pode oferecer Google Fotos, Galeria ou um gerenciador de arquivos; são aceitos PNG e JPEG.

O envio das imagens usa o HTTPS do Worker; o movimento e as rodas continuam no fluxo P2P/relay existente. Portanto, a imagem não entra nos pacotes de movimento, mas o upload e cada download contam como tráfego/requisições do Worker.

## Limites para evitar encher o armazenamento

- Até 7 MiB por imagem.
- Até 12 MiB de skins por jogador ativo.
- Até 768 MiB de skins por sala.
- As imagens do servidor duram enquanto o jogador permanece conectado. O cache do outro aparelho fica em `Application.temporaryCachePath/HTSOnlineSkins` e é apagado ao sair/desconectar.

Os limites são deliberados: Durable Objects SQLite limitam cada chave/valor a 8 MB e o plano gratuito tem limite total de armazenamento. O uso gratuito não é ilimitado; cotas da Cloudflare podem fazer um upload falhar se forem atingidas.

## Arquivos que precisam entrar na próxima versão

- `../MainMenu.cs` e `../CarController.cs` — classes de rede e aplicação da textura remota.
- Os seis scripts `SendMaterial*.cs`, além de `ImageLoader.cs` e `FileSelector.cs` nesta pasta — isolamento de material, seleção, cache local e identificação das categorias.
- `../online-bridge/worker.js` — endpoint HTTPS de upload/download, anúncio das skins e remoção ao sair.
- `../AndroidManifest.xml` e `android-plugin/src/main/java/com/hts/skin/HtsSkinUnityActivity.java` — seletor SAF.

O Worker atualizado precisa ser publicado em cada URL de ponte online que os jogadores possam usar. Se uma ponte ainda estiver com a versão antiga, a sala pode conectar, mas a sincronização das skins por ela não vai funcionar.

## Ordem para substituir as classes no dnSpy

Compile/substitua as classes nesta ordem para que cada classe veja os novos métodos das anteriores:

1. `SendMaterial.cs`.
2. `SendMaterialCarroceria.cs`, `SendMaterialDetails.cs`, `SendMaterialRodaFrente.cs`, `SendMaterialRodaTras.cs` e `SendMaterialVidros.cs`.
3. `ControlaGaragem.cs`.
4. `ImageLoader.cs` e `FileSelector.cs`.
5. `MainMenu.cs`.
6. `CarController.cs`.

Depois, publique `online-bridge/worker.js` se a sala usar Cloudflare ou envie também `render-server.js` ao Render. O Render mantém as skins somente na memória e tem limite menor por sala; reinício do serviço apaga salas e imagens.

## Etapa Android que ainda exige empacotamento

O arquivo Java é código-fonte, não uma classe já compilada. O manifesto principal continua iniciando `com.unity3d.player.UnityPlayerActivity` para o APK não quebrar enquanto o plugin não estiver empacotado. Para ativar o seletor novo, compile `HtsSkinUnityActivity.java` contra as classes Unity do jogo, inclua a classe no APK como DEX e então troque o `android:name` da Activity inicial para `com.hts.skin.HtsSkinUnityActivity`. Editar/compilar `Assembly-CSharp.dll` no dnSpy não inclui Java no APK. Sem esse passo, o jogo abre normalmente e a janela antiga OxOD é usada quando disponível. Com o plugin no APK, o Android pode oferecer Galeria, Google Fotos ou um gerenciador de arquivos.

## Referências de limites da Cloudflare

- [Durable Objects: limites de armazenamento e tamanho por valor](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects: preços e cotas](https://developers.cloudflare.com/durable-objects/platform/pricing/)
