package com.screenshare.server.config;

import io.github.cdimascio.dotenv.Dotenv;
import org.springframework.context.annotation.Configuration;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

@Configuration
public class EnvConfig {
    static {
        Path workingDirectory = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        Path envDirectory = Stream.of(workingDirectory, workingDirectory.getParent())
                .filter(directory -> directory != null && Files.isRegularFile(directory.resolve(".env")))
                .findFirst()
                .orElse(workingDirectory);
        Dotenv dotenv = Dotenv.configure()
                .directory(envDirectory.toString())
                .ignoreIfMissing()
                .load();
        dotenv.entries().forEach(entry -> System.setProperty(entry.getKey(), entry.getValue()));
    }
}
