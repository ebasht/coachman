package ws

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

const redisChannel = "coachman:ws"

type redisEnvelope struct {
	MemberIDs []string `json:"memberIds"`
	Data      []byte   `json:"data"`
}

func (h *Hub) runRedisSubscriber(ctx context.Context) {
	sub := h.redis.Subscribe(ctx, redisChannel)
	defer sub.Close()

	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			var env redisEnvelope
			if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
				continue
			}
			h.broadcastLocal(env.MemberIDs, env.Data)
		}
	}
}

func (h *Hub) dispatch(memberIDs []string, data []byte) {
	if h.redis == nil {
		h.broadcastLocal(memberIDs, data)
		return
	}
	env, err := json.Marshal(redisEnvelope{MemberIDs: memberIDs, Data: data})
	if err != nil {
		return
	}
	if err := h.redis.Publish(context.Background(), redisChannel, env).Err(); err != nil {
		slog.Error("redis publish", "err", err)
		h.broadcastLocal(memberIDs, data)
	}
}

func ParseRedisClient(url string) (*redis.Client, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return redis.NewClient(opts), nil
}
