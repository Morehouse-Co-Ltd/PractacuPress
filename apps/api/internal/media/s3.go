package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3Config configures an S3 compatible store.
type S3Config struct {
	// Bucket is the target bucket. It is created when missing.
	Bucket string
	// Region is required by the SDK even for MinIO.
	Region string
	// Endpoint points at a non AWS implementation such as MinIO. Empty means AWS.
	Endpoint string
	// AccessKey and SecretKey are optional when the environment provides credentials.
	AccessKey string
	SecretKey string
	// Prefix namespaces every key, so one bucket can host several deployments.
	Prefix string
}

// S3Storage stores objects in an S3 compatible bucket.
//
// The same Storage contract as the local store: keys come from the server, so this type
// only has to defend against a bug in key generation.
type S3Storage struct {
	client *s3.Client
	bucket string
	prefix string
}

var _ Storage = (*S3Storage)(nil)

// NewS3Storage connects and ensures the bucket exists.
func NewS3Storage(ctx context.Context, cfg S3Config) (*S3Storage, error) {
	if strings.TrimSpace(cfg.Bucket) == "" {
		return nil, errors.New("media: bucket is required")
	}

	region := cfg.Region
	if region == "" {
		region = "us-east-1"
	}

	options := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(region),
	}
	if cfg.AccessKey != "" {
		options = append(options, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
		))
	}

	loaded, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("media: load aws config: %w", err)
	}

	client := s3.NewFromConfig(loaded, func(o *s3.Options) {
		// The upload body is a live stream, which cannot be re-read to compute a
		// header checksum. Letting the SDK decide means it only asks when the operation
		// actually needs one, which keeps plaintext endpoints such as MinIO working.
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired

		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			// MinIO and moto only serve path style requests.
			o.UsePathStyle = true
		}
	})

	store := &S3Storage{
		client: client,
		bucket: cfg.Bucket,
		prefix: strings.Trim(cfg.Prefix, "/"),
	}

	if err := store.ensureBucket(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

// Bucket returns the bucket name.
func (s *S3Storage) Bucket() string { return s.bucket }

func (s *S3Storage) ensureBucket(ctx context.Context) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	if err == nil {
		return nil
	}

	if _, createErr := s.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}); createErr != nil {
		var exists *types.BucketAlreadyOwnedByYou
		var existsGlobal *types.BucketAlreadyExists
		if errors.As(createErr, &exists) || errors.As(createErr, &existsGlobal) {
			return nil
		}
		return fmt.Errorf("media: ensure bucket %q: %w", s.bucket, createErr)
	}
	return nil
}

// Put stores the object.
func (s *S3Storage) Put(ctx context.Context, key string, reader io.Reader, size int64) error {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}

	// Signature version 4 hashes the payload, which requires a re-readable body, so the
	// bytes are staged. The bound is safe: validation already rejects anything above the
	// attachment ceiling, so this cannot become an unbounded allocation.
	if size <= 0 || size > MaxAttachmentBytes {
		return errors.New("media: object size is out of range")
	}

	buffer := make([]byte, size)
	if _, err := io.ReadFull(reader, buffer); err != nil {
		return fmt.Errorf("media: read upload body: %w", err)
	}

	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(objectKey),
		Body:          bytes.NewReader(buffer),
		ContentLength: aws.Int64(size),
	})
	if err != nil {
		return fmt.Errorf("media: put object: %w", err)
	}
	return nil
}

// ReadHead returns up to n leading bytes using a ranged GET.
func (s *S3Storage) ReadHead(ctx context.Context, key string, n int) ([]byte, error) {
	if n <= 0 || n > HeadSampleSize {
		n = HeadSampleSize
	}

	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, err
	}

	response, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
		Range:  aws.String(fmt.Sprintf("bytes=0-%d", n-1)),
	})
	if err != nil {
		if isMissing(err) {
			return nil, ErrStorageObjectMissing
		}
		return nil, err
	}
	defer response.Body.Close()

	buffer := make([]byte, n)
	read, readErr := io.ReadFull(response.Body, buffer)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return nil, readErr
	}
	return buffer[:read], nil
}

// Open returns the object body for streaming.
func (s *S3Storage) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, err
	}

	response, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		if isMissing(err) {
			return nil, ErrStorageObjectMissing
		}
		return nil, err
	}
	return response.Body, nil
}

// Delete removes the object. A missing object is not an error.
func (s *S3Storage) Delete(ctx context.Context, key string) error {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}

	_, err = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	})
	return err
}

// objectKey validates a server generated key and applies the prefix.
func (s *S3Storage) objectKey(key string) (string, error) {
	if key == "" || strings.ContainsRune(key, 0) {
		return "", ErrStorageKeyUnsafe
	}
	if strings.Contains(key, "\\") || strings.HasPrefix(key, "/") {
		return "", ErrStorageKeyUnsafe
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == ".." || segment == "." {
			return "", ErrStorageKeyUnsafe
		}
	}
	if s.prefix != "" {
		return s.prefix + "/" + key, nil
	}
	return key, nil
}

// isMissing reports whether an S3 error means "no such key".
func isMissing(err error) bool {
	var noSuchKey *types.NoSuchKey
	if errors.As(err, &noSuchKey) {
		return true
	}
	var notFound *types.NotFound
	if errors.As(err, &notFound) {
		return true
	}
	// MinIO and moto answer a ranged GET on a missing key with a 416 style message that
	// the SDK does not map to a typed error, so the message is inspected as a fallback.
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "nosuchkey") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "statuscode: 404")
}


