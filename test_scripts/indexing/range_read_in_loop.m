% Range slicing inside a loop — exercises early-free liveness on
% the result tensor across iterations.
v = [1 2 3 4 5 6 7 8 9 10];
total = 0;
for k = 1:5
  chunk = v(k:k+5);
  total = total + sum(chunk);
end
disp(total);
% Re-slice the same source multiple times — each `chunk` is a fresh
% allocation, freed when its last use passes.
window = v(1:5);
disp(sum(window));
window = v(end-4:end);
disp(sum(window));
