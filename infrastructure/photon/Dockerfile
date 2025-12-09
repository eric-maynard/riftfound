FROM eclipse-temurin:21-jre-alpine

RUN apk add --no-cache curl bash

WORKDIR /photon

# Download latest Photon release
RUN curl -sL https://github.com/komoot/photon/releases/download/0.5.0/photon-0.5.0.jar -o photon.jar

# Download script that fetches country-specific data
COPY entrypoint.sh /photon/entrypoint.sh
RUN chmod +x /photon/entrypoint.sh

EXPOSE 2322

ENTRYPOINT ["/photon/entrypoint.sh"]
